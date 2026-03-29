#!/bin/bash
# Batch render using Windows Blender (GPU-accelerated via WSL2 interop).
# ~45s per character, ~22 min total for 30 characters.

LIBRARY_ROOT="${1:-/mnt/pve3a/visual-library}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RENDER_SCRIPT="$SCRIPT_DIR/render_sprites.py"
RIGGED_DIR="$LIBRARY_ROOT/rigged/characters"
MODELS_DIR="$LIBRARY_ROOT/models/characters"
TEMPLATE="$LIBRARY_ROOT/blend/character.blend"
OUTPUT_DIR="$LIBRARY_ROOT/renders"
POSES="stand,gun,machine,reload,hold,silencer"

# Windows Blender path (via WSL2 interop)
BLENDER="/mnt/c/Program Files/Blender Foundation/Blender 5.1/blender.exe"
if [ ! -f "$BLENDER" ]; then
  BLENDER="/mnt/c/Program Files/Blender Foundation/Blender 5.0/blender.exe"
fi

if [ ! -f "$BLENDER" ]; then
  echo "[ERROR] Windows Blender not found"
  exit 1
fi

# Convert paths to Windows format for Windows Blender
w_script=$(wslpath -w "$RENDER_SCRIPT")
w_template=$(wslpath -w "$TEMPLATE")
w_output=$(wslpath -w "$OUTPUT_DIR")

total=0
rendered=0
failed=0
start_time=$(date +%s)

for model in "$MODELS_DIR"/*.glb; do
  name="$(basename "$model" .glb)"
  rigged="$RIGGED_DIR/$name.glb"
  total=$((total + 1))

  if [ -f "$rigged" ]; then
    w_model=$(wslpath -w "$rigged")
    echo "[RENDER] $name (rigged) [$total/30]"
  else
    w_model=$(wslpath -w "$model")
    echo "[RENDER] $name (static) [$total/30]"
  fi

  # Clear existing renders
  rm -rf "$OUTPUT_DIR/characters/$name"

  char_start=$(date +%s)

  "$BLENDER" --background --python "$w_script" -- \
    --id "$name" \
    --category characters \
    --model "$w_model" \
    --template "$w_template" \
    --output "$w_output" \
    --poses "$POSES" \
    --force 2>&1 | grep -E "FRAMES:|ERROR|FAIL"

  char_end=$(date +%s)
  elapsed=$((char_end - char_start))

  frame_count=$(ls "$OUTPUT_DIR/characters/$name/"*.png 2>/dev/null | wc -l)
  if [ "$frame_count" -ge 48 ]; then
    echo "[OK] $name: $frame_count frames in ${elapsed}s"
    rendered=$((rendered + 1))
  else
    echo "[WARN] $name: $frame_count/48 frames in ${elapsed}s"
    failed=$((failed + 1))
  fi
  echo ""
done

end_time=$(date +%s)
total_elapsed=$(( (end_time - start_time) / 60 ))

echo "========================================="
echo "Batch render: $total total, $rendered success, $failed incomplete"
echo "Total time: ${total_elapsed} minutes"
echo "RENDERED:$rendered"
