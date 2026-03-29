#!/bin/bash
# Batch-render all rigged characters with 6 poses × 8 directions.
# Usage: bash batch_render.sh [LIBRARY_ROOT]
#
# Prefers rigged models from rigged/characters/, falls back to models/characters/.
# Clears existing renders before re-rendering (--force flag).

LIBRARY_ROOT="${1:-/mnt/pve3a/visual-library}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RENDER_SCRIPT="$SCRIPT_DIR/render_sprites.py"
RIGGED_DIR="$LIBRARY_ROOT/rigged/characters"
MODELS_DIR="$LIBRARY_ROOT/models/characters"
TEMPLATE="$LIBRARY_ROOT/blend/character.blend"
OUTPUT_DIR="$LIBRARY_ROOT/renders"
BLENDER="${BLENDER_PATH:-blender}"
POSES="stand,gun,machine,reload,hold,silencer"

total=0
rendered=0
failed=0

# Iterate over all character models (use rigged dir as primary, fall back to models)
for model in "$MODELS_DIR"/*.glb; do
  name="$(basename "$model" .glb)"
  rigged="$RIGGED_DIR/$name.glb"
  total=$((total + 1))

  # Prefer rigged model
  if [ -f "$rigged" ]; then
    input="$rigged"
    echo "[RENDER] $name (rigged)"
  else
    input="$model"
    echo "[RENDER] $name (static — no rig found)"
  fi

  # Clear existing renders for this character
  rm -rf "$OUTPUT_DIR/characters/$name"

  "$BLENDER" --background --python "$RENDER_SCRIPT" -- \
    --id "$name" \
    --category characters \
    --model "$input" \
    --template "$TEMPLATE" \
    --output "$OUTPUT_DIR" \
    --poses "$POSES" \
    --force 2>&1 | grep -E "FRAMES:|ERROR|FAIL"

  frame_count=$(ls "$OUTPUT_DIR/characters/$name/"*.png 2>/dev/null | wc -l)
  if [ "$frame_count" -ge 48 ]; then
    echo "[OK] $name: $frame_count frames"
    rendered=$((rendered + 1))
  else
    echo "[WARN] $name: only $frame_count frames (expected 48)"
    failed=$((failed + 1))
  fi
  echo ""
done

echo "========================================="
echo "Batch render: $total total, $rendered success, $failed incomplete"
echo "RENDERED:$rendered"
