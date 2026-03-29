import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueJob } from '../worker-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.ASSETGENERATOR_ROOT || resolve(__dirname, '..');
const SCRIPTS_DIR = resolve(PROJECT_ROOT, 'scripts');

export async function generate({ id, asset, config, libraryRoot }) {
  const scriptPath = join(SCRIPTS_DIR, 'generate_concepts.py');
  const outputDir = join(libraryRoot, 'concepts', asset.category);
  const workerPython = join(PROJECT_ROOT, '.venv', 'bin', 'python3');

  const args = [
    scriptPath,
    '--id', id,
    '--category', asset.category,
    '--backend', 'diffusers',
  ];

  if (asset.prompt) args.push('--prompt', asset.prompt);
  args.push('--output', outputDir, '--force');

  const result = await enqueueJob({
    cmd: workerPython, args, cwd: PROJECT_ROOT, env: {},
  });
  if (result.code !== 0) throw new Error(`generate_concepts.py (diffusers) exited ${result.code}: ${result.stderr}`);
  return { status: 'done', path: `concepts/${asset.category}/${id}.png`, backend: 'diffusers' };
}
