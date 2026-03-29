import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { enqueueJob } from '../worker-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.ASSETGENERATOR_ROOT || resolve(__dirname, '..');

const TEMPLATE_MAP = {
  characters: 'character.blend',
  weapons: 'weapon.blend',
  items: 'item.blend',
  cover: 'cover.blend',
  tiles: 'tile.blend',
  ui: 'ui.blend',
};

export async function generate({ id, asset, config, libraryRoot }) {
  const workerScript = join(PROJECT_ROOT, 'scripts', 'render_sprites.py');
  const templatePath = join(libraryRoot, 'blend', TEMPLATE_MAP[asset.category] || 'character.blend');
  const outputDir = join(libraryRoot, 'renders');
  const blenderPath = config.blenderPath || 'blender';

  // Prefer rigged model for characters (enables per-pose bone rotations)
  const riggedPath = join(libraryRoot, 'rigged', asset.category, `${id}.glb`);
  const staticPath = join(libraryRoot, 'models', asset.category, `${id}.glb`);
  const modelPath = existsSync(riggedPath) ? riggedPath : staticPath;

  const args = [
    '--background',
    '--python', workerScript,
    '--',
    '--id', id,
    '--category', asset.category,
    '--model', modelPath,
    '--template', templatePath,
    '--output', outputDir,
    '--force',
  ];

  // Pass poses from asset definition (characters have multiple poses)
  const poses = asset.poses || config.defaultPoses;
  if (poses && poses.length > 0) {
    args.push('--poses', poses.join(','));
  }

  // Pass accent color so Blender can use it for consistent rendering
  // (TripoSR vertex colors are grey on back/side faces; accent color gives
  // consistent readable appearance from all 8 directions)
  if (asset.color) {
    args.push('--accent-color', asset.color);
  }

  // Pass weapon model path for real weapon geometry (from Sketchfab etc.)
  if (asset.weaponModel) {
    const weaponPath = join(libraryRoot, asset.weaponModel);
    if (existsSync(weaponPath)) {
      args.push('--weapon-model', weaponPath);
    }
  }

  if (modelPath === riggedPath) {
    console.log(`  Using rigged model for ${id}`);
  }

  const result = await enqueueJob({ cmd: blenderPath, args, cwd: PROJECT_ROOT, env: {} });
  if (result.code !== 0) throw new Error(`Blender render exited ${result.code}: ${result.stderr.slice(-500)}`);

  const frameMatch = result.stdout.match(/FRAMES:(\d+)|Rendered (\d+) frames/i);
  const frameCount = frameMatch ? parseInt(frameMatch[1] || frameMatch[2], 10) : 0;

  if (frameCount === 0) {
    throw new Error(`Blender rendered 0 frames for "${id}". Check model exists at ${modelPath}`);
  }

  return { status: 'done', frameCount, backend: 'blender' };
}
