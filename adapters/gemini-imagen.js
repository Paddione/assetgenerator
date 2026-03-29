import { join, dirname, resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

/**
 * Gemini Imagen adapter — generates concept images via Google's Imagen API.
 * Runs on the server (cloud API, no GPU needed).
 *
 * Requires: GEMINI_API_KEY environment variable
 * Models: imagen-4.0-generate-001 (standard), imagen-4.0-fast-generate-001 (fast)
 *
 * Throws RateLimitError on 429/quota exhaustion so the server can fall back
 * to the next backend in the priority chain.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'imagen-4.0-generate-001';

/** Thrown when Gemini returns 429 or quota-related 403 */
export class RateLimitError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'RateLimitError';
    this.statusCode = statusCode;
  }
}

function apiRequest(model, apiKey, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}/${model}:predict`);
    const postData = JSON.stringify(body);

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          return reject(new RateLimitError(`Gemini rate limited (429): ${data.slice(0, 300)}`, 429));
        }
        if (res.statusCode === 403 && data.includes('quota')) {
          return reject(new RateLimitError(`Gemini quota exhausted (403): ${data.slice(0, 300)}`, 403));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Imagen API ${res.statusCode}: ${data.slice(0, 500)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Imagen API invalid JSON: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

export async function generate({ id, asset, config, libraryRoot }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable not set. Get one at https://aistudio.google.com/apikey');
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

  // Map resolution to Imagen imageSize
  const imageSize = resolution >= 2048 ? '2K' : '1K';

  console.log(`  [Imagen] Generating concept for ${id}: "${prompt.slice(0, 100)}..."`);

  const response = await apiRequest(DEFAULT_MODEL, apiKey, {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: '1:1',
      imageSize,
    },
  });

  // Extract base64 image from response
  const predictions = response.predictions;
  if (!predictions || predictions.length === 0) {
    throw new Error(`Imagen API returned no images for "${id}"`);
  }

  const imageData = predictions[0].bytesBase64Encoded;
  if (!imageData) {
    throw new Error(`Imagen API response missing image data for "${id}"`);
  }

  const buffer = Buffer.from(imageData, 'base64');
  writeFileSync(outputPath, buffer);
  console.log(`  [Imagen] Saved ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`);

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
      console.log(`  [Imagen] rembg background removed from ${outputPath}`);
    } else {
      console.warn(`  [Imagen] rembg failed (exit ${rembgResult.code}), using original`);
    }
  } catch (err) {
    console.warn(`  [Imagen] rembg step skipped: ${err.message}`);
  }

  return {
    status: 'done',
    path: `concepts/${asset.category}/${id}.png`,
    backend: 'gemini-imagen',
  };
}
