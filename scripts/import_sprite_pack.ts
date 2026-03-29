/**
 * Import sprite pack PNGs into arena/assets/renders/ with correct naming.
 *
 * Usage:
 *   npx tsx scripts/import_sprite_pack.ts [sprite_pack_png_dir] [--output DIR]
 *
 * Default source: /home/patrick/SMB-Share/Top-Down-Shooter-Sprite-Pack/PNG
 */

import fs from "node:fs";
import path from "node:path";

const SRC_DIR =
  process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : "/home/patrick/SMB-Share/Top-Down-Shooter-Sprite-Pack/PNG";
const RENDERS_DIR = path.resolve(import.meta.dirname!, "../assets/renders");

// ── Character mappings ──────────────────────────────────────────────────────

interface CharacterMapping {
  arenaId: string;
  packFolder: string;
  packPrefix: string;
}

const CHARACTERS: CharacterMapping[] = [
  { arenaId: "warrior", packFolder: "Soldier 1", packPrefix: "soldier1" },
  { arenaId: "rogue", packFolder: "Hitman 1", packPrefix: "hitman1" },
  { arenaId: "mage", packFolder: "Woman Green", packPrefix: "womanGreen" },
  { arenaId: "tank", packFolder: "Robot 1", packPrefix: "robot1" },
  { arenaId: "zombie", packFolder: "Zombie 1", packPrefix: "zoimbie1" },
];

const POSES = ["stand", "gun", "machine", "reload", "hold", "silencer"];

// ── Tile-based mappings ─────────────────────────────────────────────────────

interface TileMapping {
  arenaId: string;
  tile: string;
}

const TILES: TileMapping[] = [
  { arenaId: "floor_01", tile: "tile_13" },
  { arenaId: "floor_02", tile: "tile_14" },
  { arenaId: "floor_03", tile: "tile_15" },
  { arenaId: "floor_04", tile: "tile_16" },
  { arenaId: "wall", tile: "tile_180" },
  { arenaId: "boundary", tile: "tile_243" },
];

const ITEMS: TileMapping[] = [
  { arenaId: "health_pack", tile: "tile_240" },
  { arenaId: "armor_plate", tile: "tile_237" },
  { arenaId: "machine_gun", tile: "tile_262" },
];

const WEAPONS: TileMapping[] = [
  { arenaId: "projectile", tile: "tile_241" },
];

const COVER: TileMapping[] = [
  { arenaId: "bush", tile: "tile_183" },
  { arenaId: "pillar", tile: "tile_206" },
  { arenaId: "crate", tile: "tile_242" },
  { arenaId: "wall_cover", tile: "tile_233" },
  { arenaId: "water", tile: "tile_214" },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src: string, dest: string) {
  if (!fs.existsSync(src)) {
    console.error(`  MISSING: ${src}`);
    return false;
  }
  fs.copyFileSync(src, dest);
  return true;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const outputIdx = process.argv.indexOf('--output');
  const rendersDir = outputIdx >= 0 ? path.resolve(process.argv[outputIdx + 1]) : RENDERS_DIR;

  if (!fs.existsSync(SRC_DIR)) {
    console.error(`Source directory not found: ${SRC_DIR}`);
    process.exit(1);
  }

  console.log(`Source:  ${SRC_DIR}`);
  console.log(`Target:  ${rendersDir}`);

  // Clean existing render subdirectories (characters, tiles, items, weapons, cover)
  for (const sub of ["characters", "tiles", "items", "weapons", "cover"]) {
    const dir = path.join(rendersDir, sub);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
      console.log(`Cleaned ${sub}/`);
    }
  }

  let copied = 0;
  let missing = 0;

  // ── Characters ──────────────────────────────────────────────────────────
  console.log("\n── Characters ──");
  for (const char of CHARACTERS) {
    const destDir = path.join(rendersDir, "characters", char.arenaId);
    ensureDir(destDir);

    for (const pose of POSES) {
      const srcFile = path.join(
        SRC_DIR,
        char.packFolder,
        `${char.packPrefix}_${pose}.png`
      );
      const destFile = path.join(destDir, `${char.arenaId}-${pose}-00.png`);
      if (copyFile(srcFile, destFile)) {
        copied++;
        console.log(`  ${char.arenaId}-${pose}-00.png`);
      } else {
        missing++;
      }
    }
  }

  // ── Tile-based categories ───────────────────────────────────────────────
  const tileCategories: [string, TileMapping[]][] = [
    ["tiles", TILES],
    ["items", ITEMS],
    ["weapons", WEAPONS],
    ["cover", COVER],
  ];

  for (const [category, mappings] of tileCategories) {
    console.log(`\n── ${category} ──`);
    for (const m of mappings) {
      const destDir = path.join(rendersDir, category, m.arenaId);
      ensureDir(destDir);

      const srcFile = path.join(SRC_DIR, "Tiles", `${m.tile}.png`);
      const destFile = path.join(destDir, `${m.arenaId}-00.png`);
      if (copyFile(srcFile, destFile)) {
        copied++;
        console.log(`  ${m.arenaId}-00.png`);
      } else {
        missing++;
      }
    }
  }

  console.log(`\nDone: ${copied} files copied, ${missing} missing.`);
  if (missing > 0) process.exit(1);
}

main();
