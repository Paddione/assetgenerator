import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, '..', 'scripts');
const PACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function generate({ id, asset, config, libraryRoot }) {
  const scriptPath = join(SCRIPTS_DIR, 'pack_sprites.ts');
  const inputDir = join(libraryRoot, 'renders');
  const outputDir = join(libraryRoot, 'sprites');

  const args = [
    'tsx', scriptPath,
    '--category', asset.category,
    '--input', inputDir,
    '--output', outputDir,
  ];

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const proc = spawn('npx', args, {
      cwd: resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(reject, new Error(`pack_sprites.ts timed out after ${PACK_TIMEOUT_MS / 1000}s`));
    }, PACK_TIMEOUT_MS);

    proc.on('error', err => {
      clearTimeout(timer);
      settle(reject, new Error(`Failed to spawn pack_sprites.ts: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const reason = signal ? `killed by ${signal}` : `exited ${code}`;
        return settle(reject, new Error(`pack_sprites.ts ${reason}: ${stderr}`));
      }

      const pngPath = join(outputDir, `${asset.category}.png`);
      const size = existsSync(pngPath) ? statSync(pngPath).size : 0;

      settle(resolvePromise, {
        status: 'done',
        backend: 'packer',
        atlasSize: size,
      });
    });
  });
}
