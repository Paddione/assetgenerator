/**
 * Blender MCP adapter — Direct TCP communication with Blender's MCP addon.
 *
 * Bypasses the GPU worker WebSocket layer for faster, more direct control.
 * Supports two pipeline phases:
 *   model  — Generate 3D models via Hunyuan3D local or Sketchfab, export GLB
 *   render — Render sprites by spawning a headless Blender subprocess via execute_code
 *
 * Falls back to standard adapters (blender.js, hunyuan3d-local.js, etc.) when unreachable.
 */

import net from 'node:net';
import { resolve, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.ASSETGENERATOR_ROOT || resolve(__dirname, '..');

const BLENDER_HOST = process.env.BLENDER_MCP_HOST || process.env.BLENDER_HOST || '10.10.0.3';
const BLENDER_PORT = parseInt(process.env.BLENDER_MCP_PORT || process.env.BLENDER_PORT || '9876', 10);
const HUNYUAN3D_URL = process.env.HUNYUAN3D_LOCAL_URL || 'http://10.10.0.3:8081';

const TEMPLATE_MAP = {
  characters: 'character.blend',
  weapons: 'weapon.blend',
  items: 'item.blend',
  cover: 'cover.blend',
  tiles: 'tile.blend',
  ui: 'ui.blend',
};

// ─── TCP Client ───────────────────────────────────────────────────────────────

/**
 * Send a JSON command to the Blender MCP addon via TCP and return the result.
 * Opens a fresh connection per command (addon spawns a thread per client).
 */
function sendCommand(command, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let buffer = '';
    let settled = false;

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      client.destroy();
      fn(val);
    };

    client.connect(BLENDER_PORT, BLENDER_HOST, () => {
      // Write command and half-close (signal end-of-write while keeping read open)
      client.end(JSON.stringify(command));
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      try {
        const response = JSON.parse(buffer);
        if (response.status === 'error') {
          settle(reject, new Error(response.message || 'Blender MCP error'));
        } else {
          settle(resolve, response.result);
        }
      } catch {
        // Incomplete JSON — keep accumulating
      }
    });

    client.on('error', (err) =>
      settle(reject, new Error(`Blender MCP connection failed: ${err.message}`)));
    client.setTimeout(timeoutMs, () => {
      client.destroy();
      settle(reject, new Error(`Blender MCP timeout after ${timeoutMs}ms`));
    });
  });
}

/**
 * Execute arbitrary Blender Python code. Returns { executed: bool, result: string (stdout) }.
 */
async function executeCode(code, timeoutMs = 300000) {
  return sendCommand({ type: 'execute_code', params: { code } }, timeoutMs);
}

// ─── Exported Utilities ───────────────────────────────────────────────────────

/** Check if Blender MCP addon is reachable (fast 5s ping). */
export async function isAvailable() {
  try {
    const info = await sendCommand({ type: 'get_scene_info', params: {} }, 5000);
    return !!info;
  } catch {
    return false;
  }
}

/** Get current Blender scene info for diagnostics / QA. */
export async function getSceneInfo() {
  return sendCommand({ type: 'get_scene_info', params: {} }, 10000);
}

/** Capture a viewport screenshot (for QA between pipeline stages). */
export async function screenshot(filepath) {
  return sendCommand({ type: 'get_viewport_screenshot', params: { filepath, max_size: 800 } }, 15000);
}

// ─── Model Generation ─────────────────────────────────────────────────────────

/**
 * Generate a 3D model via Hunyuan3D local server, import into Blender, export GLB.
 * Requires Hunyuan3D local server running at HUNYUAN3D_LOCAL_URL.
 */
async function generateModelHunyuan({ id, asset, libraryRoot }) {
  const outputDir = join(libraryRoot, 'models', asset.category);
  const outputPath = join(outputDir, `${id}.glb`);
  const prompt = asset.prompt || asset.name;

  const code = `
import requests, tempfile, os, bpy

# Health check: fail fast if Hunyuan3D is not running
try:
    r = requests.get(${JSON.stringify(HUNYUAN3D_URL + '/health')}, timeout=5)
    if r.status_code != 200:
        raise Exception('unhealthy')
except Exception as e:
    raise Exception(f'Hunyuan3D local server not reachable at ${HUNYUAN3D_URL}: {e}')

# Clear existing mesh objects so the export only contains the new model
for obj in list(bpy.data.objects):
    if obj.type == 'MESH':
        bpy.data.objects.remove(obj, do_unlink=True)

# Generate model
print('Generating model via Hunyuan3D local...')
response = requests.post(${JSON.stringify(HUNYUAN3D_URL + '/generate')}, json={
    'text': ${JSON.stringify(prompt)},
    'octree_resolution': 256,
    'num_inference_steps': 25,
    'guidance_scale': 5.5,
    'texture': False
}, timeout=120)

if response.status_code != 200:
    raise Exception(f'Hunyuan3D generation failed ({response.status_code}): {response.text[:200]}')

# Import generated GLB
with tempfile.NamedTemporaryFile(delete=False, suffix='.glb') as f:
    f.write(response.content)
    temp_path = f.name

bpy.ops.import_scene.gltf(filepath=temp_path)
os.unlink(temp_path)
print(f'Model imported into Blender scene')

# Export to library path
os.makedirs(${JSON.stringify(outputDir)}, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=${JSON.stringify(outputPath)},
    export_format='GLB',
    use_selection=False
)
print('MODEL_EXPORTED:${outputPath}')
`;

  const result = await executeCode(code, 180000);
  if (!result.executed || !result.result?.includes('MODEL_EXPORTED:')) {
    throw new Error(`Hunyuan3D model generation failed: ${result.result || 'No output'}`);
  }

  return {
    status: 'done',
    path: `models/${asset.category}/${id}.glb`,
    backend: 'blender-mcp-hunyuan',
  };
}

/**
 * Source a model from Sketchfab via the addon's native handler, then export GLB.
 * Requires Sketchfab integration enabled in Blender addon + API key set.
 */
async function generateModelSketchfab({ id, asset, libraryRoot }) {
  const outputDir = join(libraryRoot, 'models', asset.category);
  const outputPath = join(outputDir, `${id}.glb`);

  // Use the addon's native Sketchfab download (handles auth, temp files, import)
  const downloadResult = await sendCommand({
    type: 'download_sketchfab_model',
    params: { uid: asset.sketchfabUid, name: id },
  }, 60000);

  if (downloadResult?.error) {
    throw new Error(`Sketchfab download failed: ${downloadResult.error}`);
  }

  // Export the imported model to the library path
  const code = `
import bpy, os
os.makedirs(${JSON.stringify(outputDir)}, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=${JSON.stringify(outputPath)},
    export_format='GLB',
    use_selection=False
)
print('MODEL_EXPORTED:${outputPath}')
`;

  const result = await executeCode(code, 30000);
  if (!result.executed || !result.result?.includes('MODEL_EXPORTED:')) {
    throw new Error(`GLB export after Sketchfab import failed: ${result.result || 'No output'}`);
  }

  return {
    status: 'done',
    path: `models/${asset.category}/${id}.glb`,
    backend: 'blender-mcp-sketchfab',
  };
}

// ─── Sprite Rendering ─────────────────────────────────────────────────────────

/**
 * Render sprites from a 3D model using the existing render_sprites.py script.
 * Spawns a headless Blender subprocess via execute_code (avoids disrupting
 * the running Blender scene while reusing the proven render logic).
 */
async function renderSprites({ id, asset, config, libraryRoot }) {
  const workerScript = join(PROJECT_ROOT, 'scripts', 'render_sprites.py');
  const templatePath = join(libraryRoot, 'blend', TEMPLATE_MAP[asset.category] || 'character.blend');
  const outputDir = join(libraryRoot, 'renders');
  const blenderPath = config.blenderPath || 'blender';

  const riggedPath = join(libraryRoot, 'rigged', asset.category, `${id}.glb`);
  const staticPath = join(libraryRoot, 'models', asset.category, `${id}.glb`);

  const poses = asset.poses || config.categories?.[asset.category]?.defaultPoses || ['idle'];

  // Optional args
  const optionalArgs = [];
  if (asset.color) {
    optionalArgs.push(`'--accent-color', ${JSON.stringify(asset.color)},`);
  }
  if (asset.weaponModel) {
    const weaponPath = join(libraryRoot, asset.weaponModel);
    if (existsSync(weaponPath)) {
      optionalArgs.push(`'--weapon-model', ${JSON.stringify(weaponPath)},`);
    }
  }

  const code = `
import subprocess, os, sys

rigged = ${JSON.stringify(riggedPath)}
static = ${JSON.stringify(staticPath)}
model_path = rigged if os.path.exists(rigged) else static

if not os.path.exists(model_path):
    raise Exception(f'Model not found at {model_path} or {rigged}')

if model_path == rigged:
    print('Using rigged model for ${id}')

# Resolve Blender binary from this process (reliable even without PATH)
_configured = ${JSON.stringify(blenderPath)}
_from_exe = os.path.abspath(os.path.join(os.path.dirname(sys.executable), '..', '..', 'blender'))
blender_bin = _from_exe if os.path.isfile(_from_exe) else _configured

args = [
    blender_bin,
    '--background', ${JSON.stringify(templatePath)},
    '--python', ${JSON.stringify(workerScript)},
    '--',
    '--id', ${JSON.stringify(id)},
    '--category', ${JSON.stringify(asset.category)},
    '--model', model_path,
    '--template', ${JSON.stringify(templatePath)},
    '--output', ${JSON.stringify(outputDir)},
    '--force',
    '--poses', ${JSON.stringify(poses.join(','))},
    ${optionalArgs.join('\n    ')}
]
# Filter out any trailing empty strings from optional arg construction
args = [a for a in args if a]

print(f'Launching render subprocess with {len(args)} args...')
result = subprocess.run(args, capture_output=True, text=True, timeout=300)
print(f'EXIT_CODE:{result.returncode}')
if result.stdout:
    # Print last 2000 chars of stdout (contains frame count)
    print(result.stdout[-2000:])
if result.returncode != 0 and result.stderr:
    print(f'STDERR:{result.stderr[-500:]}')
`;

  const result = await executeCode(code, 360000); // 6 min max for full character render
  const output = result.result || '';

  // Parse exit code
  const exitMatch = output.match(/EXIT_CODE:(\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 1;
  if (exitCode !== 0) {
    const stderrMatch = output.match(/STDERR:([\s\S]*)/);
    throw new Error(`Blender render exited ${exitCode}: ${stderrMatch?.[1]?.trim() || output.slice(-500)}`);
  }

  // Parse frame count (same pattern as blender.js adapter)
  const frameMatch = output.match(/FRAMES:(\d+)|Rendered (\d+) frames/i);
  const frameCount = frameMatch ? parseInt(frameMatch[1] || frameMatch[2], 10) : 0;

  if (frameCount === 0) {
    throw new Error(`Blender MCP rendered 0 frames for "${id}". Output: ${output.slice(-300)}`);
  }

  return { status: 'done', frameCount, backend: 'blender-mcp' };
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Adapter generate() — routes to model generation or sprite rendering
 * based on asset._currentPhase (set by server.js before calling).
 */
export async function generate({ id, asset, config, libraryRoot }) {
  const phase = asset._currentPhase;

  if (phase === 'model') {
    if (asset.sketchfabUid) {
      return generateModelSketchfab({ id, asset, libraryRoot });
    }
    return generateModelHunyuan({ id, asset, libraryRoot });
  }

  if (phase === 'render') {
    return renderSprites({ id, asset, config, libraryRoot });
  }

  throw new Error(`blender-mcp adapter does not support phase "${phase}"`);
}
