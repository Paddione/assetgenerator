import { resolve, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enqueueJob } from '../worker-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.ASSETGENERATOR_ROOT || resolve(__dirname, '..');

export async function generate({ id, asset, config, libraryRoot }) {
  const conceptPath = join(libraryRoot, 'concepts', asset.category, `${id}.png`);
  const outputDir = join(libraryRoot, 'models', asset.category);
  const outputPath = join(outputDir, `${id}.glb`);

  // Paths resolved for the worker machine
  const workerScript = join(PROJECT_ROOT, 'scripts', 'generate_3d.py');
  const workerPython = join(PROJECT_ROOT, '.venv', 'bin', 'python3');

  const args = [
    workerScript,
    '--id', id,
    '--backend', 'triposr',
    '--input', conceptPath,
    '--output', outputDir,
    '--force',
  ];

  const result = await enqueueJob({
    cmd: workerPython, args, cwd: PROJECT_ROOT, env: {},
  });
  if (result.code !== 0) throw new Error(`generate_3d.py exited ${result.code}: ${result.stderr}`);

  // Verify the output file was actually created on the shared filesystem
  if (!existsSync(outputPath)) {
    throw new Error(`generate_3d.py exited 0 but ${outputPath} was not created. Check worker has access to ${libraryRoot}`);
  }

  return { status: 'done', path: `models/${asset.category}/${id}.glb`, backend: 'triposr' };
}
