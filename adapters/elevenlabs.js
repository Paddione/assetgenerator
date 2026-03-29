import { resolve } from 'node:path';
import { enqueueJob, getWorkerStatus } from '../worker-manager.js';
import { spawn } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * ElevenLabs adapter — dispatches generate_audio.py to GPU worker when available,
 * falls back to local spawn (for dev/testing outside K8s).
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
    '--backend', 'elevenlabs',
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

  // Use GPU worker if connected, otherwise fall back to local spawn
  const workerStatus = getWorkerStatus();
  if (workerStatus.connected) {
    const result = await enqueueJob({ cmd: pythonPath, args, cwd: projectDir, env });
    if (result.code !== 0) {
      throw new Error(`generate_audio.py (elevenlabs) exited ${result.code}: ${result.stderr}`);
    }
    const seedMatch = result.stdout.match(/SEED:(\d+)/);
    const actualSeed = seedMatch ? parseInt(seedMatch[1], 10) : seed;
    return { seed: actualSeed, stdout: result.stdout, stderr: result.stderr };
  }

  // Fallback: local spawn (for dev outside K8s)
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(pythonPath, args, {
      cwd: projectDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`generate_audio.py (elevenlabs) exited ${code}: ${stderr}`));
      }

      // Copy generated WAV to NAS outputPath if provided
      if (outputPath && projectConfig.audioRoot) {
        const audioRoot = resolve(basePath, projectConfig.audioRoot);
        const subdir = type === 'music' ? 'music' : 'sfx';
        const projectWav = join(audioRoot, subdir, `${id}.wav`);
        if (existsSync(projectWav)) {
          const destDir = dirname(outputPath);
          if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
          copyFileSync(projectWav, outputPath);
        }
      }

      const seedMatch = stdout.match(/SEED:(\d+)/);
      const actualSeed = seedMatch ? parseInt(seedMatch[1], 10) : seed;
      resolvePromise({ seed: actualSeed, stdout, stderr });
    });
  });
}
