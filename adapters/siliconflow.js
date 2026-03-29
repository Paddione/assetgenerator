import { join, dirname, resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

/**
 * SiliconFlow adapter — generates concept images via SiliconFlow's image API.
 * Supports FLUX.1, Kolors, and other models. Runs on the server (cloud API, no GPU needed).
 *
 * Requires: SILICONFLOW_API_KEY environment variable
 * Get key at: https://cloud.siliconflow.cn/account/ak
 *
 * Available models:
 *   - black-forest-labs/FLUX.1-schnell  (fast, 1-4 steps)
 *   - black-forest-labs/FLUX.1-dev      (high quality)
 *   - Kwai-Kolors/Kolors               (good general purpose)
 *   - stabilityai/stable-diffusion-xl-base-1.0
 */

const API_URL = 'https://api.siliconflow.cn/v1/images/generations';
const DEFAULT_MODEL = 'black-forest-labs/FLUX.1-schnell';

function apiRequest(apiKey, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL);
    const postData = JSON.stringify(body);

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`SiliconFlow API ${res.statusCode}: ${data.slice(0, 500)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`SiliconFlow API invalid JSON: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function downloadImage(imageUrl) {
  return new Promise((resolve, reject) => {
    https.get(imageUrl, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Image download failed: ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

export async function generate({ id, asset, config, libraryRoot }) {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new Error('SILICONFLOW_API_KEY environment variable not set. Get one at https://cloud.siliconflow.cn/account/ak');
  }

  const outputDir = join(libraryRoot, 'concepts', asset.category);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${id}.png`);

  const basePrompt = asset.prompt || `${asset.category} game asset: ${id}`;
  // Safety clause FIRST (higher token weight), then style directive
  const safetyClause = 'no shadows, no watermark, no signature, no text, no letters, no words, no labels';
  const styleDirective = '3D rendered game asset, stylized low-poly 3D model, clean geometry, flat even lighting, isometric perspective';
  const prompt = `${safetyClause}, ${basePrompt}, ${styleDirective}`;
  const resolution = asset.conceptResolution || 1024;

  console.log(`  [SiliconFlow] Generating concept for ${id}: "${prompt.slice(0, 80)}..."`);

  const response = await apiRequest(apiKey, {
    model: DEFAULT_MODEL,
    prompt,
    image_size: `${resolution}x${resolution}`,
    num_inference_steps: 4,
    seed: asset.seed || 0,
  });

  // Response contains image URLs (valid for 1 hour)
  const images = response.images;
  if (!images || images.length === 0) {
    throw new Error(`SiliconFlow API returned no images for "${id}"`);
  }

  const imageUrl = images[0].url;
  if (!imageUrl) {
    throw new Error(`SiliconFlow API response missing image URL for "${id}"`);
  }

  // Download and save
  const buffer = await downloadImage(imageUrl);
  writeFileSync(outputPath, buffer);
  console.log(`  [SiliconFlow] Saved ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`);

  // Remove white background via rembg on the worker before TripoSR uses the image.
  try {
    const { enqueueJob } = await import('../worker-manager.js');
    const PROJECT_ROOT = process.env.ASSETGENERATOR_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const workerPython = join(PROJECT_ROOT, '.venv', 'bin', 'python3');
    const rembgScript = join(PROJECT_ROOT, 'scripts', 'rembg_concept.py');

    const rembgResult = await enqueueJob({
      cmd: workerPython,
      args: [rembgScript, '--input', outputPath, '--output', outputPath],
      cwd: PROJECT_ROOT,
      env: {},
    });

    if (rembgResult.code === 0) {
      console.log(`  [SiliconFlow] rembg background removed from ${outputPath}`);
    } else {
      console.warn(`  [SiliconFlow] rembg failed (exit ${rembgResult.code}), using original`);
    }
  } catch (err) {
    console.warn(`  [SiliconFlow] rembg step skipped: ${err.message}`);
  }

  return {
    status: 'done',
    path: `concepts/${asset.category}/${id}.png`,
    backend: 'siliconflow',
  };
}
