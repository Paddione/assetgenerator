import { resolve } from 'node:path';
import { enqueueJob } from '../worker-manager.js';

/**
 * AudioCraft adapter — dispatches generate_audio.py to GPU worker.
 * Uses --backend auto so the script picks AudioCraft (if torch+CUDA available)
 * or falls back to ElevenLabs (if ELEVENLABS_API_KEY set).
 * Captures SEED:<n> from stdout for state tracking.
 * Worker writes directly to NAS — no local copy needed.
 */
export async function generate({ id, type, prompt, seed, duration, outputPath, projectConfig }) {
  const basePath = process.env.ASSETGENERATOR_ROOT || projectConfig._basePath;
  const scriptPath = resolve(basePath, projectConfig.generateScript);
  const pythonPath = projectConfig.pythonPath
    ? resolve(basePath, projectConfig.pythonPath)
    : 'python3';
  const projectDir = resolve(basePath, projectConfig.audioRoot, '..', '..');

  const args = [
    scriptPath,
    '--id', id,
    '--type', type,
    '--backend', 'auto',
    '--force',
  ];

  if (prompt) args.push('--prompt', prompt);
  if (seed != null) args.push('--seed', String(seed));
  if (duration != null) args.push('--duration', String(duration));
  if (outputPath) args.push('--output', outputPath);

  const env = {};
  if (process.env.ELEVENLABS_API_KEY) {
    env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  }

  const result = await enqueueJob({ cmd: pythonPath, args, cwd: projectDir, env });
  if (result.code !== 0) {
    throw new Error(`generate_audio.py exited ${result.code}: ${result.stderr}`);
  }
  const seedMatch = result.stdout.match(/SEED:(\d+)/);
  const actualSeed = seedMatch ? parseInt(seedMatch[1], 10) : seed;
  return { seed: actualSeed, stdout: result.stdout, stderr: result.stderr };
}
