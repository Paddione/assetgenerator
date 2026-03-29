#!/usr/bin/env python3
"""
rembg_concept.py - Remove background from an API-generated concept image.

Used as a post-processing step after Gemini Imagen, SiliconFlow, or any other
cloud API that returns RGB PNGs with white/gradient backgrounds.

Without this step, TripoSR reconstructs the white background as a large
curved shell/wall artifact visible in all rendered sprite frames.

Usage:
    python3 rembg_concept.py --input /path/to/concept.png --output /path/to/concept.png
"""

import argparse
import io
import sys
from pathlib import Path


def remove_background(input_path: Path, output_path: Path) -> bool:
    try:
        import numpy as np
        import rembg
        from PIL import Image

        img = Image.open(input_path).convert('RGB')

        # Composite onto mid-grey canvas before rembg for best contrast
        # (white canvas causes rembg to miss light-colored subject areas)
        grey = Image.new('RGB', img.size, (128, 128, 128))
        grey.paste(img)

        buf = io.BytesIO()
        grey.save(buf, format='PNG')
        result_bytes = rembg.remove(buf.getvalue())
        result = Image.open(io.BytesIO(result_bytes)).convert('RGBA')

        # Tighten alpha: zero out pixels with alpha < 200 to kill fringe geometry
        arr = np.array(result)
        arr[arr[:, :, 3] < 200, 3] = 0
        result = Image.fromarray(arr)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        result.save(str(output_path), 'PNG')
        print(f'  [rembg] Background removed: {output_path.name}')
        return True

    except ImportError as e:
        print(f'  [rembg] Skipped — missing dependency: {e}', file=sys.stderr)
        return False
    except Exception as e:
        print(f'  [rembg] Failed: {e}', file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description='Remove background from concept image')
    parser.add_argument('--input', required=True, help='Input PNG path')
    parser.add_argument('--output', required=True, help='Output PNG path (can be same as input)')
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        print(f'Error: input file not found: {input_path}', file=sys.stderr)
        sys.exit(1)

    ok = remove_background(input_path, output_path)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
