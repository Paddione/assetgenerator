import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const FAL_BASE = 'https://queue.fal.run/fal-ai/hunyuan3d-v3';
const POLL_INTERVAL = 10_000; // 10 seconds
const POLL_TIMEOUT = 300_000; // 5 minutes

function getApiKey() {
  const key = process.env.HUNYUAN3D_API_KEY || process.env.FAL_KEY;
  if (!key) {
    const err = new Error('HUNYUAN3D_API_KEY (or FAL_KEY) not set');
    err.name = 'RateLimitError';
    throw err;
  }
  return key;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Submit a Hunyuan3D generation job via fal.ai queue API.
 * Supports text-to-3d or image-to-3d depending on inputs.
 */
async function submitJob({ prompt, imageUrl }) {
  const key = getApiKey();

  // Choose endpoint based on input type
  const endpoint = imageUrl ? 'image-to-3d' : 'text-to-3d';
  const body = {};

  if (prompt) body.prompt = prompt.slice(0, 1024);
  if (imageUrl) body.image_url = imageUrl;

  body.generate_type = 'Normal';
  body.face_count = 100000; // reasonable for game assets
  body.enable_pbr = true;

  const res = await fetch(`${FAL_BASE}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const err = new Error('Hunyuan3D (fal.ai) rate limit exceeded');
    err.name = 'RateLimitError';
    throw err;
  }
  if (!res.ok) throw new Error(`Hunyuan3D submit failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return { requestId: data.request_id, statusUrl: data.status_url, responseUrl: data.response_url };
}

/**
 * Poll until generation is complete. Returns the result response URL.
 */
async function pollUntilDone(statusUrl) {
  const key = getApiKey();
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT) {
    const res = await fetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
    });

    if (!res.ok) throw new Error(`Hunyuan3D status check failed: ${res.status}`);
    const data = await res.json();

    if (data.status === 'COMPLETED') return data.response_url;
    if (data.status !== 'IN_PROGRESS' && data.status !== 'IN_QUEUE') {
      throw new Error(`Hunyuan3D generation failed: ${data.status}`);
    }

    await sleep(POLL_INTERVAL);
  }

  throw new Error('Hunyuan3D generation timed out after 5 minutes');
}

/**
 * Fetch the result and download the GLB file.
 */
async function downloadResult(responseUrl, outputPath) {
  const key = getApiKey();

  const res = await fetch(responseUrl, {
    headers: { Authorization: `Key ${key}` },
  });
  if (!res.ok) throw new Error(`Hunyuan3D result fetch failed: ${res.status}`);
  const data = await res.json();

  // GLB URL in model_glb.url or model_urls.glb.url
  const glbUrl = data.model_glb?.url || data.model_urls?.glb?.url;
  if (!glbUrl) throw new Error('No GLB URL found in Hunyuan3D response');

  const fileRes = await fetch(glbUrl);
  if (!fileRes.ok) throw new Error(`GLB download failed: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  const dir = join(outputPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, buffer);

  return outputPath;
}

/**
 * Upload a local concept image to fal.ai storage for use as input.
 */
async function uploadImage(imagePath) {
  const key = getApiKey();
  const imageBuffer = readFileSync(imagePath);

  const res = await fetch('https://fal.run/fal-ai/any/upload', {
    method: 'PUT',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'image/png',
    },
    body: imageBuffer,
  });

  // If upload endpoint is not available, fall back to text-only
  if (!res.ok) return null;
  const data = await res.json();
  return data.url || null;
}

/**
 * Generate adapter interface — full Hunyuan3D pipeline: submit → poll → download.
 */
export async function generate({ id, asset, config, libraryRoot }) {
  const conceptPath = join(libraryRoot, 'concepts', asset.category, `${id}.png`);
  const outputPath = join(libraryRoot, 'models', asset.category, `${id}.glb`);

  // Try to use concept image if available
  let imageUrl = null;
  if (existsSync(conceptPath)) {
    imageUrl = await uploadImage(conceptPath);
  }

  const { statusUrl, responseUrl } = await submitJob({
    prompt: asset.prompt,
    imageUrl,
  });

  // If we got a direct response URL, use it; otherwise poll
  let finalResponseUrl = responseUrl;
  if (statusUrl) {
    finalResponseUrl = await pollUntilDone(statusUrl);
  }

  await downloadResult(finalResponseUrl, outputPath);

  return { status: 'done', path: `models/${asset.category}/${id}.glb`, backend: 'hunyuan3d' };
}
