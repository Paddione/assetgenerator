import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const API_BASE = 'https://api.hyper3d.com/api/v2';
const POLL_INTERVAL = 10_000; // 10 seconds
const POLL_TIMEOUT = 300_000; // 5 minutes

function getApiKey() {
  const key = process.env.HYPER3D_API_KEY;
  if (!key) {
    const err = new Error('HYPER3D_API_KEY not set');
    err.name = 'RateLimitError';
    throw err;
  }
  return key;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Submit a Rodin generation job.
 * Supports text-to-3d (prompt only) or image-to-3d (concept image).
 */
async function submitJob({ prompt, imagePath }) {
  const key = getApiKey();
  const formData = new FormData();

  if (imagePath) {
    const imageBuffer = readFileSync(imagePath);
    const blob = new Blob([imageBuffer], { type: 'image/png' });
    formData.append('images', blob, 'concept.png');
  }

  if (prompt) {
    formData.append('prompt', prompt);
  }

  formData.append('geometry_file_format', 'glb');
  formData.append('material', 'PBR');
  formData.append('quality', 'medium');
  formData.append('tier', 'Regular');

  const res = await fetch(`${API_BASE}/rodin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: formData,
  });

  if (res.status === 429) {
    const err = new Error('Hyper3D rate limit exceeded');
    err.name = 'RateLimitError';
    throw err;
  }
  if (!res.ok) throw new Error(`Hyper3D submit failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  if (data.error) throw new Error(`Hyper3D submit error: ${data.error}`);

  return {
    uuid: data.uuid,
    subscriptionKey: data.jobs?.subscription_key,
  };
}

/**
 * Poll until generation is complete. Returns when status is 'Done'.
 */
async function pollUntilDone(subscriptionKey) {
  const key = getApiKey();
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT) {
    const res = await fetch(`${API_BASE}/status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subscription_key: subscriptionKey }),
    });

    if (!res.ok) throw new Error(`Hyper3D status check failed: ${res.status}`);
    const data = await res.json();

    const job = data.jobs?.[0];
    if (!job) throw new Error('No job found in status response');

    if (job.status === 'Done') return job.uuid;
    if (job.status === 'Failed') throw new Error('Hyper3D generation failed');

    await sleep(POLL_INTERVAL);
  }

  throw new Error('Hyper3D generation timed out after 5 minutes');
}

/**
 * Download the generated GLB file.
 */
async function downloadResult(taskUuid, outputPath) {
  const key = getApiKey();

  const res = await fetch(`${API_BASE}/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ task_uuid: taskUuid }),
  });

  if (!res.ok) throw new Error(`Hyper3D download failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Hyper3D download error: ${data.error}`);

  // Find the GLB file in the result list
  const glbFile = data.list?.find(f => f.name?.endsWith('.glb'));
  if (!glbFile?.url) throw new Error('No GLB file found in Hyper3D download response');

  const fileRes = await fetch(glbFile.url);
  if (!fileRes.ok) throw new Error(`GLB download failed: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  const dir = join(outputPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, buffer);

  return outputPath;
}

/**
 * Generate adapter interface — full Hyper3D pipeline: submit → poll → download.
 */
export async function generate({ id, asset, config, libraryRoot }) {
  const conceptPath = join(libraryRoot, 'concepts', asset.category, `${id}.png`);
  const outputPath = join(libraryRoot, 'models', asset.category, `${id}.glb`);

  // Use concept image if available, otherwise text prompt
  const hasImage = await import('node:fs').then(fs => fs.existsSync(conceptPath));

  const { uuid, subscriptionKey } = await submitJob({
    prompt: asset.prompt,
    imagePath: hasImage ? conceptPath : null,
  });

  const taskUuid = await pollUntilDone(subscriptionKey);
  await downloadResult(taskUuid || uuid, outputPath);

  return { status: 'done', path: `models/${asset.category}/${id}.glb`, backend: 'hyper3d' };
}
