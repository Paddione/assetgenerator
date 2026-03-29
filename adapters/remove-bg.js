import { readFileSync, writeFileSync } from 'node:fs';
import { getWorkerStatus, enqueueJob } from '../worker-manager.js';

const KEEP_BACKGROUND_CATEGORIES = new Set(['tiles']);

/**
 * Remove background from a concept image.
 * Uses GPU worker (rembg) if available, falls back to @imgly/background-removal-node.
 *
 * @param {string} imagePath - Absolute path to PNG on shared NAS
 * @param {string} category - Asset category (tiles keep their background)
 * @returns {Promise<{method: string}>} - Which method was used
 */
export async function removeBackground(imagePath, category) {
  if (KEEP_BACKGROUND_CATEGORIES.has(category)) {
    console.log(`  [BG] Skipping background removal for category "${category}"`);
    return { method: 'skipped' };
  }

  const worker = getWorkerStatus();
  if (worker.connected) {
    return removeViaWorker(imagePath);
  }
  return removeViaNode(imagePath);
}

async function removeViaWorker(imagePath) {
  console.log(`  [BG] Removing background via GPU worker (rembg): ${imagePath}`);
  const result = await enqueueJob({
    cmd: '.venv/bin/python3',
    args: ['-c', `
from rembg import remove
from PIL import Image
img = Image.open("${imagePath}")
result = remove(img)
result.save("${imagePath}", "PNG")
print("OK")
`],
    cwd: '/home/patrick/projects/Assetgenerator',
  });

  if (result.code !== 0) {
    console.warn(`  [BG] rembg failed (code ${result.code}): ${result.stderr.slice(0, 200)}`);
    console.log('  [BG] Falling back to Node.js background removal');
    return removeViaNode(imagePath);
  }

  console.log('  [BG] Background removed via rembg (GPU)');
  return { method: 'rembg' };
}

async function removeViaNode(imagePath) {
  console.log(`  [BG] Removing background via Node.js (ONNX): ${imagePath}`);
  try {
    const { removeBackground: removeBg } = await import('@imgly/background-removal-node');
    const inputBuffer = readFileSync(imagePath);
    const blob = new Blob([inputBuffer], { type: 'image/png' });
    const resultBlob = await removeBg(blob);
    const arrayBuffer = await resultBlob.arrayBuffer();
    writeFileSync(imagePath, Buffer.from(arrayBuffer));
    console.log('  [BG] Background removed via Node.js (ONNX CPU)');
    return { method: 'node-onnx' };
  } catch (err) {
    console.warn(`  [BG] Node.js background removal failed: ${err.message}`);
    throw err;
  }
}
