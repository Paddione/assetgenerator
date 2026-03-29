/**
 * Figma adapter — Pulls assets from Figma as concept art via the REST API.
 *
 * Integration points:
 *   1. UI/Tiles concept: Export designed Figma components as pixel-perfect PNGs
 *   2. Reference images: Pull designer sketches for image-to-3D model generation
 *   3. Design tokens: Extract color palettes for pipeline integration (accent colors)
 *   4. Component listing: Discover available Figma components for asset mapping
 *
 * Requires:
 *   - FIGMA_API_KEY env var (Personal Access Token)
 *   - FIGMA_FILE_KEY env var (default file key, overridable per-asset)
 *   - asset.figmaNodeId set on the visual asset to export
 */

import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const FIGMA_API_KEY = process.env.FIGMA_API_KEY || '';
const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY || '';
const FIGMA_API_BASE = 'https://api.figma.com/v1';

// ─── BackendSkipError ─────────────────────────────────────────────────────────

/** Thrown when an asset is not configured for this backend (no figmaNodeId). */
class BackendSkipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackendSkipError';
  }
}

// ─── Figma API Client ─────────────────────────────────────────────────────────

async function figmaFetch(path) {
  if (!FIGMA_API_KEY) throw new Error('FIGMA_API_KEY not set');

  const res = await fetch(`${FIGMA_API_BASE}${path}`, {
    headers: { 'X-Figma-Token': FIGMA_API_KEY },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Figma API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

// ─── Exported Utilities ───────────────────────────────────────────────────────

/** Check if Figma integration is configured and reachable. */
export async function isAvailable() {
  if (!FIGMA_API_KEY || !FIGMA_FILE_KEY) return false;
  try {
    await figmaFetch(`/files/${FIGMA_FILE_KEY}/meta`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Export a Figma node as a PNG image.
 * @param {string} fileKey — Figma file key
 * @param {string} nodeId — Node ID (e.g. "123:456")
 * @param {string} outputPath — Local file path to write PNG
 * @param {number} scale — Export scale (1–4, default 4 for max quality)
 */
export async function exportNodeAsPng(fileKey, nodeId, outputPath, scale = 4) {
  const data = await figmaFetch(
    `/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`
  );

  const imageUrl = data.images?.[nodeId];
  if (!imageUrl) {
    throw new Error(`Figma returned no image for node "${nodeId}" — check the node ID exists in file ${fileKey}`);
  }

  // Download the rendered image
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to download Figma render: ${imgRes.status}`);
  const buffer = Buffer.from(await imgRes.arrayBuffer());

  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, buffer);

  return { path: outputPath, size: buffer.length };
}

/**
 * Extract design tokens (fill colors) from Figma file styles.
 * Returns { "Style Name": { hex: "#rrggbb", opacity: 1 }, ... }
 */
export async function extractDesignTokens(fileKey) {
  fileKey = fileKey || FIGMA_FILE_KEY;
  if (!fileKey) throw new Error('No Figma file key provided');

  // Get file with styles metadata
  const file = await figmaFetch(`/files/${fileKey}?depth=1`);
  const styles = file.styles || {};

  // Filter to FILL (color) styles and collect their node IDs
  const colorStyleIds = [];
  const styleNameMap = {};
  for (const [nodeId, style] of Object.entries(styles)) {
    if (style.style_type === 'FILL') {
      colorStyleIds.push(nodeId);
      styleNameMap[nodeId] = style.name;
    }
  }

  if (colorStyleIds.length === 0) return {};

  // Fetch nodes to get actual color values
  const idsParam = colorStyleIds.map(id => encodeURIComponent(id)).join(',');
  const nodesData = await figmaFetch(`/files/${fileKey}/nodes?ids=${idsParam}`);

  const colors = {};
  for (const [nodeId, nodeData] of Object.entries(nodesData.nodes || {})) {
    const fills = nodeData?.document?.fills;
    if (fills?.[0]?.type === 'SOLID') {
      const { r, g, b, a } = fills[0].color;
      const hex = '#' + [r, g, b]
        .map(c => Math.round(c * 255).toString(16).padStart(2, '0'))
        .join('');
      colors[styleNameMap[nodeId]] = { hex, opacity: a ?? 1 };
    }
  }

  return colors;
}

/**
 * List available components in the Figma file.
 * Returns [{ nodeId, name, description, componentSetName }, ...]
 */
export async function listComponents(fileKey) {
  fileKey = fileKey || FIGMA_FILE_KEY;
  if (!fileKey) throw new Error('No Figma file key provided');

  const file = await figmaFetch(`/files/${fileKey}?depth=1`);
  const components = file.components || {};

  return Object.entries(components).map(([nodeId, comp]) => ({
    nodeId,
    name: comp.name,
    description: comp.description || '',
    componentSetName: comp.componentSetName || null,
  }));
}

// ─── Concept Phase Generator ──────────────────────────────────────────────────

/**
 * Generate concept art by exporting a Figma node as PNG.
 * Requires asset.figmaNodeId. Throws BackendSkipError if not set,
 * allowing the fallback chain to continue to AI generation.
 */
export async function generate({ id, asset, config, libraryRoot }) {
  if (!asset.figmaNodeId) {
    throw new BackendSkipError(`No figmaNodeId on "${id}" — skipping Figma`);
  }

  if (!FIGMA_API_KEY) {
    throw new Error('FIGMA_API_KEY environment variable not set');
  }

  const fileKey = asset.figmaFileKey || FIGMA_FILE_KEY;
  if (!fileKey) {
    throw new Error('No Figma file key — set FIGMA_FILE_KEY env var or asset.figmaFileKey');
  }

  const catConfig = config.categories?.[asset.category] || {};
  const conceptRes = catConfig.conceptResolution || 1024;

  // Export scale: Figma max is 4. Higher scale for smaller target resolutions.
  const scale = Math.min(4, Math.max(1, Math.ceil(conceptRes / 256)));

  const outputDir = join(libraryRoot, 'concepts', asset.category);
  const outputPath = join(outputDir, `${id}.png`);

  console.log(`  [Figma] Exporting node ${asset.figmaNodeId} from file ${fileKey} (scale=${scale})`);
  const { size } = await exportNodeAsPng(fileKey, asset.figmaNodeId, outputPath, scale);
  console.log(`  [Figma] Saved ${(size / 1024).toFixed(1)}KB to ${outputPath}`);

  return {
    status: 'done',
    path: `concepts/${asset.category}/${id}.png`,
    backend: 'figma',
  };
}
