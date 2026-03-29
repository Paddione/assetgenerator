#!/usr/bin/env node
/**
 * Export game UI and tile assets from figma-assets.html as individual PNGs.
 * Uses Playwright to render and screenshot each element with transparency.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';

const LIBRARY_ROOT = '/mnt/pve3a/visual-library';
const ASSETS = [
  { id: 'health_bar',    category: 'ui' },
  { id: 'ammo_counter',  category: 'ui' },
  { id: 'crosshair',     category: 'ui' },
  { id: 'action_button', category: 'ui' },
  { id: 'minimap_frame', category: 'ui' },
  { id: 'grass_tile',    category: 'tiles' },
  { id: 'concrete_tile', category: 'tiles' },
  { id: 'sand_tile',     category: 'tiles' },
  { id: 'water_tile',    category: 'tiles' },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:8765/figma-assets.html');
await page.waitForLoadState('networkidle');

const results = [];
for (const asset of ASSETS) {
  const dir = join(LIBRARY_ROOT, 'concepts', asset.category);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${asset.id}.png`);
  const el = page.locator(`#${asset.id}`);
  await el.screenshot({ path: filePath, omitBackground: true });

  const { size } = statSync(filePath);
  results.push(`  ${asset.id} (${asset.category}): ${(size / 1024).toFixed(1)}KB → ${filePath}`);
}

await browser.close();
console.log('Exported assets:');
results.forEach(r => console.log(r));
