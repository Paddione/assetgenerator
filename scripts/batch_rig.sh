#!/bin/bash
# Batch-rig all character models that don't have rigged counterparts.
# Usage: bash batch_rig.sh [LIBRARY_ROOT]
#
# Reads unrigged models from models/characters/ and outputs to rigged/characters/
# Uses simple_rig.py for fast 21-bone humanoid skeleton generation.

FORCE=false
LIBRARY_ROOT=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) [ -z "$LIBRARY_ROOT" ] && LIBRARY_ROOT="$arg" ;;
  esac
done
LIBRARY_ROOT="${LIBRARY_ROOT:-/mnt/pve3a/visual-library}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="$LIBRARY_ROOT/models/characters"
RIGGED_DIR="$LIBRARY_ROOT/rigged/characters"
BLENDER="${BLENDER_PATH:-blender}"

mkdir -p "$RIGGED_DIR"

total=0
rigged=0
skipped=0
failed=0

for model in "$MODELS_DIR"/*.glb; do
  name="$(basename "$model")"
  output="$RIGGED_DIR/$name"
  total=$((total + 1))

  if [ -f "$output" ] && [ "$FORCE" = false ]; then
    echo "[SKIP] $name (already rigged, use --force to overwrite)"
    skipped=$((skipped + 1))
    continue
  fi

  echo "[RIG] $name"
  "$BLENDER" --background --python "$SCRIPT_DIR/simple_rig.py" -- \
    --input "$model" --output "$output" 2>&1 | tail -5

  if [ -f "$output" ]; then
    echo "[OK] $name → $(du -h "$output" | cut -f1)"
    rigged=$((rigged + 1))
  else
    echo "[FAIL] $name — output not created"
    failed=$((failed + 1))
  fi
  echo ""
done

echo "========================================="
echo "Batch rig complete: $total total, $rigged rigged, $skipped skipped, $failed failed"
echo "RIGGED:$rigged"
