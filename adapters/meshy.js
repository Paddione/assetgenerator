import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, '..', 'scripts');

export async function generate({ id, asset, config, libraryRoot }) {
  const scriptPath = join(SCRIPTS_DIR, 'generate_3d.py');
  const conceptPath = join(libraryRoot, 'concepts', asset.category, `${id}.png`);
  const outputDir = join(libraryRoot, 'models', asset.category);

  const args = [
    scriptPath,
    '--id', id,
    '--backend', 'meshy',
    '--input', conceptPath,
    '--output', outputDir,
    '--force',
  ];

  return new Promise((resolvePromise, reject) => {
    const proc = spawn('python3', args, {
      cwd: resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`generate_3d.py (meshy) exited ${code}: ${stderr}`));
      resolvePromise({
        status: 'done',
        path: `models/${asset.category}/${id}.glb`,
        backend: 'meshy',
      });
    });
  });
}
