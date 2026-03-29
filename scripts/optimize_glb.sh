#!/usr/bin/env bash
set -euo pipefail
INPUT="$1"
OUTPUT="$2"
if [ ! -f "$INPUT" ]; then echo "ERROR: Input file not found: $INPUT" >&2; exit 1; fi
npx --yes @gltf-transform/cli optimize "$INPUT" "$OUTPUT" --compress draco --texture-compress webp
echo "SUCCESS: Optimized $INPUT -> $OUTPUT ($(stat -c%s "$OUTPUT") bytes)"
