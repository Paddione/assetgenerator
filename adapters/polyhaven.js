import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const API_BASE = 'https://api.polyhaven.com';
/**
 * Search PolyHaven assets by type and optional category filter.
 * @param {object} opts
 * @param {'hdris'|'textures'|'models'} opts.type
 * @param {string} [opts.categories] - Comma-separated category filter
 */
export async function search({ type = 'textures', categories }) {
  const params = new URLSearchParams({ t: type });
  if (categories) params.set('categories', categories);

  const res = await fetch(`${API_BASE}/assets?${params}`);
  if (!res.ok) throw new Error(`PolyHaven search failed: ${res.status}`);
  const data = await res.json();

  return Object.entries(data).map(([id, info]) => ({
    id,
    name: info.name,
    categories: info.categories,
    tags: info.tags,
    download_count: info.download_count,
  }));
}

/**
 * Get available files/resolutions for an asset.
 */
export async function getAssetInfo(assetId) {
  const res = await fetch(`${API_BASE}/files/${assetId}`);
  if (!res.ok) throw new Error(`PolyHaven asset info failed: ${res.status}`);
  return res.json();
}

/**
 * Download a PolyHaven asset file.
 * @param {object} opts
 * @param {string} opts.assetId - PolyHaven asset ID
 * @param {'hdris'|'textures'|'models'} opts.type
 * @param {string} [opts.resolution='1k'] - Resolution (1k, 2k, 4k)
 * @param {string} [opts.format] - File format (hdr, exr, jpg, png, gltf, fbx)
 * @param {string} opts.outputPath - Where to save
 */
export async function download({ assetId, type, resolution = '1k', format, outputPath }) {
  // Get file info to find the exact download URL
  const info = await getAssetInfo(assetId);

  let url;
  if (type === 'hdris') {
    const fmt = format || 'hdr';
    url = info?.hdri?.[resolution]?.[fmt]?.url;
  } else if (type === 'textures') {
    // For textures, download the diffuse/color map by default
    const fmt = format || 'jpg';
    const mapType = info?.['Diffuse'] || info?.['Color'] || info?.['Base Color'];
    url = mapType?.[resolution]?.[fmt]?.url;
    // Fallback: try to find any texture map
    if (!url) {
      for (const [, maps] of Object.entries(info)) {
        if (maps?.[resolution]?.[fmt]?.url) {
          url = maps[resolution][fmt].url;
          break;
        }
      }
    }
  } else if (type === 'models') {
    const fmt = format || 'gltf';
    url = info?.gltf?.[resolution]?.gltf?.url || info?.[fmt]?.[resolution]?.[fmt]?.url;
  }

  if (!url) {
    throw new Error(`No download URL found for ${assetId} (${type}/${resolution}/${format || 'default'})`);
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`PolyHaven download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const dir = join(outputPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, buffer);

  return { path: outputPath, source: 'polyhaven', assetId };
}

/**
 * Generate adapter interface — downloads a PolyHaven model as the 3D model source.
 * Requires asset.polyhavenId to be set.
 */
export async function generate({ id, asset, config, libraryRoot }) {
  if (!asset.polyhavenId) {
    const err = new Error('No polyhavenId set on asset — use PolyHaven sourcing first');
    err.name = 'RateLimitError'; // triggers fallback to next backend
    throw err;
  }

  const outputPath = join(libraryRoot, 'models', asset.category, `${id}.glb`);
  await download({
    assetId: asset.polyhavenId,
    type: 'models',
    resolution: '1k',
    format: 'gltf',
    outputPath,
  });

  return { status: 'done', path: `models/${asset.category}/${id}.glb`, backend: 'polyhaven' };
}
