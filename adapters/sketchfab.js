import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const API_BASE = 'https://api.sketchfab.com/v3';

function getApiKey() {
  const key = process.env.SKETCHFAB_API_KEY;
  if (!key) {
    const err = new Error('SKETCHFAB_API_KEY not set');
    err.name = 'RateLimitError';
    throw err;
  }
  return key;
}

/**
 * Search Sketchfab for downloadable models.
 */
export async function search({ query, count = 20 }) {
  const key = getApiKey();
  const params = new URLSearchParams({
    type: 'models',
    q: query,
    downloadable: 'true',
    count: String(count),
    sort_by: '-relevance',
  });

  const res = await fetch(`${API_BASE}/search?${params}`, {
    headers: { Authorization: `Token ${key}` },
  });
  if (!res.ok) throw new Error(`Sketchfab search failed: ${res.status}`);
  const data = await res.json();

  return data.results.map(m => ({
    uid: m.uid,
    name: m.name,
    thumbnail: m.thumbnails?.images?.[0]?.url,
    vertexCount: m.vertexCount,
    faceCount: m.faceCount,
    isAnimated: m.isAnimated,
  }));
}

/**
 * Download a Sketchfab model by UID, extract GLB.
 */
export async function download({ uid, outputPath, targetSize = 1.0 }) {
  const key = getApiKey();

  // Get download URL
  const dlRes = await fetch(`${API_BASE}/models/${uid}/download`, {
    headers: { Authorization: `Token ${key}` },
  });
  if (dlRes.status === 429) {
    const err = new Error('Sketchfab rate limit exceeded');
    err.name = 'RateLimitError';
    throw err;
  }
  if (!dlRes.ok) throw new Error(`Sketchfab download info failed: ${dlRes.status}`);
  const dlData = await dlRes.json();

  // Prefer glTF then pick first available format
  const format = dlData.gltf || dlData.glb || Object.values(dlData)[0];
  if (!format?.url) throw new Error('No downloadable format found');

  // Download the archive
  const archiveRes = await fetch(format.url);
  if (!archiveRes.ok) throw new Error(`Sketchfab archive download failed: ${archiveRes.status}`);
  const buffer = Buffer.from(await archiveRes.arrayBuffer());

  // Sketchfab delivers a zip — extract the GLB/glTF
  const dir = outputPath.replace(/\.[^.]+$/, '_sketchfab_tmp');
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, 'model.zip');
  writeFileSync(zipPath, buffer);

  // Use system unzip to extract
  const { execFileSync } = await import('node:child_process');
  execFileSync('unzip', ['-o', zipPath, '-d', dir], { stdio: 'pipe' });

  // Find GLB or glTF in extracted files
  const { readdirSync } = await import('node:fs');
  const findGlb = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, f.name);
      if (f.isDirectory()) { const r = findGlb(full); if (r) return r; }
      if (f.name.endsWith('.glb') || f.name.endsWith('.gltf')) return full;
    }
    return null;
  };

  const modelFile = findGlb(dir);
  if (!modelFile) throw new Error('No GLB/glTF found in Sketchfab download');

  const { copyFileSync, rmSync } = await import('node:fs');
  const outDir = join(outputPath, '..');
  mkdirSync(outDir, { recursive: true });
  copyFileSync(modelFile, outputPath);
  rmSync(dir, { recursive: true, force: true });

  return { path: outputPath, source: 'sketchfab', uid, targetSize };
}

/**
 * Generate adapter interface — downloads a Sketchfab model as the 3D model phase.
 * Requires asset.sketchfabUid to be set (via /api/visual-library/:id/source/sketchfab).
 */
export async function generate({ id, asset, config, libraryRoot }) {
  if (!asset.sketchfabUid) {
    const err = new Error('No sketchfabUid set on asset — use Sketchfab sourcing endpoint first');
    err.name = 'RateLimitError'; // triggers fallback to next backend
    throw err;
  }

  const outputPath = join(libraryRoot, 'models', asset.category, `${id}.glb`);
  const catConfig = config.categories?.[asset.category] || {};
  const targetSize = catConfig.size ? catConfig.size / 64 : 1.0;

  await download({ uid: asset.sketchfabUid, outputPath, targetSize });

  return { status: 'done', path: `models/${asset.category}/${id}.glb`, backend: 'sketchfab' };
}
