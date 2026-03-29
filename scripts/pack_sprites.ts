#!/usr/bin/env npx tsx
/**
 * Phase 4: Sprite Sheet Packing
 *
 * Reads rendered PNGs from assets/renders/ and packs them into sprite sheet
 * atlases compatible with PixiJS Spritesheet format.
 *
 * Output: atlas.png + atlas.json per category in frontend/public/assets/sprites/
 *
 * Usage:
 *   npx tsx scripts/pack_sprites.ts [--category <name>] [--input <dir>] [--output <dir>]
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// We use free-tex-packer-core for atlas packing
// Install: npm install --save-dev free-tex-packer-core
import { packAsync } from 'free-tex-packer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RENDERS_DIR = path.resolve(__dirname, '..', 'assets', 'renders');
const MANIFEST_PATH = path.resolve(__dirname, '..', 'assets', 'manifest.json');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'frontend', 'public', 'assets', 'sprites');

interface ManifestMeta {
  character_size: number;
  item_size: number;
  tile_size: number;
  ui_size: number;
}

interface ManifestCharacter {
  id: string;
  poses?: string[];
  animations?: Record<string, { frames: number; fps: number }>;
  directions?: string[];
}

interface Manifest {
  meta: ManifestMeta;
  characters: ManifestCharacter[];
  weapons: Array<{ id: string; frames: number; size: number }>;
  items: Array<{ id: string; frames: number; size: number }>;
  tiles: Array<{ id: string }>;
  cover: Array<{ id: string }>;
  ui: Array<{ id: string; size: number }>;
}

function loadManifest(): Manifest {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { meta: {} as ManifestMeta, characters: [], weapons: [], items: [], tiles: [], cover: [], ui: [] };
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Collect all PNG files from a directory tree, returning { path, name } pairs.
 */
function collectPngs(dir: string, prefix = ''): Array<{ filePath: string; name: string }> {
  const results: Array<{ filePath: string; name: string }> = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const namePrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectPngs(fullPath, namePrefix));
    } else if (entry.name.endsWith('.png')) {
      results.push({ filePath: fullPath, name: namePrefix });
    }
  }
  return results;
}

/**
 * Build PixiJS-compatible spritesheet JSON from free-tex-packer output.
 * Adds animation metadata for AnimatedSprite consumption.
 */
function addAnimations(
  frames: Record<string, any>,
  category: string,
  manifest: Manifest
): Record<string, string[]> {
  const animations: Record<string, string[]> = {};

  // Build animation groups for characters
  if (category === 'characters') {
    for (const char of manifest.characters) {
      // Pose-based: each character has single-frame poses (no directions)
      const poses = (char as any).poses || [];
      for (const pose of poses) {
        const frameName = `${char.id}/${char.id}-${pose}-00`;
        if (frames[frameName]) {
          animations[`${char.id}_${pose}`] = [frameName];
        }
      }
    }
  }

  // Build animation groups for items/weapons
  if (category === 'items' || category === 'weapons') {
    const assets = category === 'items' ? manifest.items : manifest.weapons;
    for (const asset of assets) {
      const frameNames: string[] = [];
      for (let i = 0; i < (asset.frames || 1); i++) {
        const frameName = `${asset.id}/${asset.id}-${i.toString().padStart(2, '0')}`;
        if (frames[frameName]) {
          frameNames.push(frameName);
        }
      }
      if (frameNames.length > 0) {
        animations[`${asset.id}_idle`] = frameNames;
      }
    }
  }

  return animations;
}

async function packCategory(category: string, manifest: Manifest, rendersDir: string, spritesOutputDir: string) {
  const renderDir = path.join(rendersDir, category);
  const pngs = collectPngs(renderDir);

  if (pngs.length === 0) {
    console.log(`  [SKIP] ${category} — no rendered PNGs found`);
    return;
  }

  console.log(`  [PACK] ${category} — ${pngs.length} frames`);

  // Prepare images for packer
  const images = pngs.map(({ filePath, name }) => ({
    path: name,
    contents: fs.readFileSync(filePath),
  }));

  try {
    const results = await packAsync(images, {
      textureName: category,
      width: 2048,
      height: 2048,
      fixedSize: false,
      powerOfTwo: true,
      padding: 2,
      allowRotation: false,
      detectIdentical: true,
      allowTrim: true,
      exporter: 'JsonHash',
      removeFileExtension: true,
    });

    ensureDir(spritesOutputDir);

    // Separate PNG and JSON results, pairing them by page index
    const pngResults = results.filter(r => r.name.endsWith('.png'));
    const jsonResults = results.filter(r => r.name.endsWith('.json'));
    const pageCount = pngResults.length;

    // PixiJS multi-page spritesheet format:
    //   Page 0: {category}.json + {category}.png (main, has related_multi_packs)
    //   Page N: {category}-N.json + {category}-N.png
    // PixiJS auto-loads related packs when loading the main spritesheet.

    const pageJsonNames: string[] = [];
    let totalFrames = 0;

    for (let i = 0; i < pageCount; i++) {
      const pageSuffix = i === 0 ? '' : `-${i}`;
      const pngName = `${category}${pageSuffix}.png`;
      const jsonName = `${category}${pageSuffix}.json`;
      pageJsonNames.push(jsonName);

      // Write PNG
      const pngPath = path.join(spritesOutputDir, pngName);
      fs.writeFileSync(pngPath, pngResults[i].buffer);
      console.log(`    → ${pngPath} (${(pngResults[i].buffer.length / 1024).toFixed(0)}KB)`);

      // Write JSON for this page
      if (i < jsonResults.length) {
        const packerData = JSON.parse(jsonResults[i].buffer.toString());
        const frameCount = Object.keys(packerData.frames || {}).length;
        totalFrames += frameCount;

        // Add animations only to the main page (page 0)
        if (i === 0) {
          // Collect ALL frames across all pages for animation grouping
          const allFrames: Record<string, any> = {};
          for (const jr of jsonResults) {
            const pd = JSON.parse(jr.buffer.toString());
            Object.assign(allFrames, pd.frames || {});
          }
          const animations = addAnimations(allFrames, category, manifest);
          if (Object.keys(animations).length > 0) {
            packerData.animations = animations;
          }
        }

        // Set image reference and multi-pack links
        if (packerData.meta) {
          packerData.meta.image = pngName;
          if (pageCount > 1 && i === 0) {
            // Main page lists all other pages
            packerData.meta.related_multi_packs = pageJsonNames.slice(1)
              .concat(Array.from({ length: pageCount - 1 - i }, (_, j) => `${category}-${j + i + 1}.json`))
              .filter((v, idx, arr) => arr.indexOf(v) === idx);
          }
        }

        const jsonPath = path.join(spritesOutputDir, jsonName);
        fs.writeFileSync(jsonPath, JSON.stringify(packerData, null, 2));
        console.log(`    → ${jsonPath} (${frameCount} frames)`);
      }
    }

    // Fix: update main page's related_multi_packs now that we know all page names
    if (pageCount > 1) {
      const mainJsonPath = path.join(spritesOutputDir, `${category}.json`);
      const mainData = JSON.parse(fs.readFileSync(mainJsonPath, 'utf-8'));
      mainData.meta.related_multi_packs = pageJsonNames.slice(1);
      // Each sub-page also needs its own image reference
      fs.writeFileSync(mainJsonPath, JSON.stringify(mainData, null, 2));
    }

    // Also write per-page JSON image refs for sub-pages
    for (let i = 1; i < pageCount; i++) {
      const jsonPath = path.join(spritesOutputDir, pageJsonNames[i]);
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      if (data.meta) {
        data.meta.image = `${category}-${i}.png`;
      }
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    }

    console.log(`    Total: ${totalFrames} frames across ${pageCount} page(s)`);

  } catch (err) {
    console.error(`  [ERROR] Packing ${category} failed:`, err);
    process.exitCode = 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const categoryIdx = args.indexOf('--category');
  const targetCategory = categoryIdx >= 0 ? args[categoryIdx + 1] : null;

  const inputIdx = args.indexOf('--input');
  const outputIdx = args.indexOf('--output');
  const rendersDir = inputIdx >= 0 ? path.resolve(args[inputIdx + 1]) : RENDERS_DIR;
  const spritesOutputDir = outputIdx >= 0 ? path.resolve(args[outputIdx + 1]) : OUTPUT_DIR;

  const manifest = loadManifest();
  const categories = ['characters', 'items', 'weapons', 'tiles', 'cover', 'ui'];

  console.log('Arena Sprite Sheet Packer');
  console.log('========================\n');

  for (const category of categories) {
    if (targetCategory && category !== targetCategory) continue;
    await packCategory(category, manifest, rendersDir, spritesOutputDir);
  }

  console.log('\n[DONE] Sprite sheets saved to', spritesOutputDir);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
