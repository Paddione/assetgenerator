import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const DEFAULT_URL = 'http://10.10.0.3:8081';
const POLL_INTERVAL = 3_000;  // 3 seconds
const POLL_TIMEOUT = 180_000; // 3 minutes

function getBaseUrl() {
  return process.env.HUNYUAN3D_LOCAL_URL || DEFAULT_URL;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Check if the local Hunyuan3D server is running.
 */
async function isHealthy() {
  try {
    const res = await fetch(`${getBaseUrl()}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Generate a GLB model from a concept image via the local Hunyuan3D server.
 * Uses the sync /generate endpoint (blocks until complete).
 */
async function generateFromImage(imagePath, opts = {}) {
  const baseUrl = getBaseUrl();
  const imageB64 = readFileSync(imagePath).toString('base64');

  const body = {
    image: imageB64,
    remove_background: true,
    texture: false, // Shape-only (texture needs >21GB VRAM)
    seed: opts.seed || 1234,
    octree_resolution: opts.octreeResolution || 256,
    num_inference_steps: opts.numInferenceSteps || 5,
    guidance_scale: opts.guidanceScale || 5.0,
    type: 'glb',
  };

  const res = await fetch(`${baseUrl}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POLL_TIMEOUT),
  });

  if (res.status === 429 || res.status === 503) {
    const err = new Error('Hunyuan3D local server busy or unavailable');
    err.name = 'RateLimitError';
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Hunyuan3D local generate failed: ${res.status} ${errText}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Async generation via /send + /status polling.
 * Used when sync endpoint times out or for better progress tracking.
 */
async function generateAsync(imagePath, opts = {}) {
  const baseUrl = getBaseUrl();
  const imageB64 = readFileSync(imagePath).toString('base64');

  const body = {
    image: imageB64,
    remove_background: true,
    texture: false,
    seed: opts.seed || 1234,
    octree_resolution: opts.octreeResolution || 256,
    num_inference_steps: opts.numInferenceSteps || 5,
    guidance_scale: opts.guidanceScale || 5.0,
    type: 'glb',
  };

  // Submit job
  const submitRes = await fetch(`${baseUrl}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!submitRes.ok) throw new Error(`Hunyuan3D submit failed: ${submitRes.status}`);
  const { uid } = await submitRes.json();

  // Poll for result
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT) {
    const statusRes = await fetch(`${baseUrl}/status/${uid}`);
    if (!statusRes.ok) throw new Error(`Status check failed: ${statusRes.status}`);
    const data = await statusRes.json();

    if (data.status === 'completed' && data.model_base64) {
      return Buffer.from(data.model_base64, 'base64');
    }
    if (data.status === 'error') {
      throw new Error(`Hunyuan3D generation failed: ${data.message || 'unknown error'}`);
    }

    await sleep(POLL_INTERVAL);
  }

  throw new Error('Hunyuan3D local generation timed out');
}

/**
 * Generate adapter interface — matches the standard adapter contract.
 * Calls the local Hunyuan3D FastAPI server on the GPU worker.
 */
export async function generate({ id, asset, config, libraryRoot }) {
  // Check if server is available
  const healthy = await isHealthy();
  if (!healthy) {
    const err = new Error('Hunyuan3D local server not running (is gpu-worker up?)');
    err.name = 'RateLimitError'; // triggers fallback to next backend
    throw err;
  }

  const conceptPath = join(libraryRoot, 'concepts', asset.category, `${id}.png`);
  const outputPath = join(libraryRoot, 'models', asset.category, `${id}.glb`);

  if (!existsSync(conceptPath)) {
    throw new Error(`Concept image not found: ${conceptPath}`);
  }

  // Try sync generation first (simpler), fall back to async on timeout
  let glbBuffer;
  try {
    glbBuffer = await generateFromImage(conceptPath);
  } catch (err) {
    if (err.name === 'AbortError' || err.message.includes('timeout')) {
      console.log('  Sync generation timed out, trying async...');
      glbBuffer = await generateAsync(conceptPath);
    } else {
      throw err;
    }
  }

  const dir = join(outputPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, glbBuffer);

  return { status: 'done', path: `models/${asset.category}/${id}.glb`, backend: 'hunyuan3d-local' };
}
