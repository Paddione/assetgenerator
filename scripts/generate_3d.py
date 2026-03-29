#!/usr/bin/env python3
"""
Phase 2: Image -> 3D Model Conversion
Converts concept art PNGs to 3D models using TripoSR (local) or Meshy.ai (cloud).

Usage:
    python generate_3d.py [--backend auto|triposr|meshy] [--category CATEGORY] [--id ASSET_ID]
                          [--input PATH] [--output DIR]

    --backend       Generation backend (default: auto-detect)
    --meshy-key     Meshy.ai API key (or set MESHY_API_KEY env var)
    --category      Only process this category
    --id            Only process this asset ID
    --input         Input concept image or directory (overrides default)
    --output        Output directory (overrides default)
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

MANIFEST_PATH = Path(__file__).parent.parent / "assets" / "manifest.json"
CONCEPTS_DIR = Path(__file__).parent.parent / "assets" / "concepts"
OUTPUT_BASE = Path(__file__).parent.parent / "assets" / "models"

# Add TripoSR to path if cloned into .venv
TRIPOSR_PATH = Path(__file__).parent.parent / ".venv" / "TripoSR"
if TRIPOSR_PATH.exists() and str(TRIPOSR_PATH) not in sys.path:
    sys.path.insert(0, str(TRIPOSR_PATH))

# Categories that need 3D models (tiles/ui are 2D-only)
CATEGORIES_3D = {"characters", "weapons", "items", "cover"}


def load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        return {"meta": {}, "characters": [], "weapons": [], "items": [], "tiles": [], "cover": [], "ui": []}
    with open(MANIFEST_PATH) as f:
        return json.load(f)


def ensure_output_dir(category: str) -> Path:
    out = OUTPUT_BASE / category
    out.mkdir(parents=True, exist_ok=True)
    return out


# =============================================================================
# TripoSR Backend (Local)
# =============================================================================

_triposr_model = None

def triposr_available() -> bool:
    """Check if TripoSR dependencies are installed."""
    try:
        import torch
        if not torch.cuda.is_available():
            return False
        # Check for the correct TripoSR package (installed from git)
        from tsr.system import TSR  # noqa: F401
        return True
    except ImportError:
        # Also try the alternative import path
        try:
            from TripoSR.tsr.system import TSR  # noqa: F401
            return True
        except ImportError:
            return False


def _has_meaningful_alpha(image: 'Image.Image', threshold: float = 0.15) -> bool:
    """
    Return True if the image is RGBA and at least `threshold` fraction of pixels
    are substantially transparent (alpha < 128).  Used to decide whether rembg
    should run — concepts that already had background removed in Phase 1 don't
    need (and are harmed by) a second rembg pass.
    """
    if image.mode != 'RGBA':
        return False
    alpha = image.split()[3]
    transparent = sum(1 for p in alpha.getdata() if p < 128)
    ratio = transparent / (image.size[0] * image.size[1])
    return ratio >= threshold


def _remove_background(image: 'Image.Image') -> 'Image.Image':
    """
    Remove background from concept art using rembg (u2net model).

    IMPORTANT: Skips rembg if the image already has meaningful alpha transparency
    (≥15% of pixels transparent).  Running rembg on an already-transparent image
    corrupts the alpha channel because PIL's .convert('RGB') composites onto
    BLACK — rembg then sees dark subject areas as background and produces noisy,
    incomplete masks that TripoSR reconstructs as floating particle geometry.

    Only runs rembg on RGB images (or RGBA with negligible transparency) where
    the background is a solid/gradient colour that needs removal.
    """
    from PIL import Image
    import io

    # Already has clean alpha — skip rembg to avoid corruption
    if _has_meaningful_alpha(image):
        print("  [REMBG] Image already has alpha transparency — skipping (no background to remove)")
        return image.convert('RGBA')

    try:
        import rembg
        # Composite onto a MID-GREY canvas (#808080) before rembg.
        # White canvas causes rembg to miss light-colored character areas
        # (white hoodie, white shoes blend into white background → incomplete mask).
        # Black canvas causes issues with dark areas.
        # Mid-grey gives maximum contrast separation for both light and dark subjects.
        grey_bg = Image.new('RGB', image.size, (128, 128, 128))
        if image.mode == 'RGBA':
            grey_bg.paste(image, mask=image.split()[3])
        else:
            grey_bg.paste(image.convert('RGB'))

        buf = io.BytesIO()
        grey_bg.save(buf, format='PNG')
        result_bytes = rembg.remove(buf.getvalue())
        result = Image.open(io.BytesIO(result_bytes)).convert('RGBA')

        # Tighten the alpha mask: zero out any pixel where alpha < 200
        # to prevent semi-transparent fringe from being reconstructed as geometry
        import numpy as np
        arr = np.array(result)
        arr[arr[:, :, 3] < 200, 3] = 0
        result = Image.fromarray(arr)

        print("  [REMBG] Background removed successfully")
        return result
    except ImportError:
        print("  [WARN] rembg not installed — background removal skipped (install: pip install rembg)")
        return image.convert('RGBA')
    except Exception as e:
        print(f"  [WARN] rembg failed ({e}) — continuing without background removal")
        return image.convert('RGBA')


def _prepare_for_triposr(image: 'Image.Image', target: int = 512, foreground_ratio: float = 0.85) -> 'Image.Image':
    """
    Crop to subject bounding box, centre and scale to fill `foreground_ratio`
    of a square white canvas at `target` px.  Input must be RGBA.
    TripoSR performs best when the subject fills ~85% of the frame with a
    clean white background — no gradients, shadows, or background remnants.
    """
    from PIL import Image

    # Hard-threshold alpha: ignore faint fringe/anti-alias pixels.
    # Threshold 128 (not 30) — lower values let rembg noise and anti-alias
    # fringe through, which TripoSR reconstructs as floating particle geometry.
    alpha = image.split()[3]
    alpha_thresh = alpha.point(lambda p: 255 if p > 128 else 0)
    bbox = alpha_thresh.getbbox()
    if bbox:
        # Add a small margin (2% of longest side) to avoid clipping at edges
        w, h = image.size
        margin = int(max(w, h) * 0.02)
        x0 = max(0, bbox[0] - margin)
        y0 = max(0, bbox[1] - margin)
        x1 = min(w, bbox[2] + margin)
        y1 = min(h, bbox[3] + margin)
        image = image.crop((x0, y0, x1, y1))

    cw, ch = image.size
    scale = foreground_ratio * target / max(cw, ch)
    new_w, new_h = int(cw * scale), int(ch * scale)
    image = image.resize((new_w, new_h), Image.LANCZOS)

    # Composite onto pure white — no gradient, no shadow
    canvas = Image.new('RGBA', (target, target), (255, 255, 255, 255))
    paste_x = (target - new_w) // 2
    paste_y = (target - new_h) // 2
    canvas.paste(image, (paste_x, paste_y), mask=image.split()[3])
    return canvas.convert('RGB')


def _keep_central_component(mesh) -> object:
    """
    Remove floating geometry from a TripoSR mesh by keeping the connected
    component whose centroid is closest to the origin.

    TripoSR places the reconstructed subject at (0,0,0).  Shell/dome artifacts
    and particle clouds orbit further out.  Vertex-count selection is unreliable
    because the shell surface often has MORE vertices than the compact character
    body — centroid distance is a much better discriminator.

    Uses trimesh's split() to find connected components, then picks the one
    nearest the origin.  Falls back silently if trimesh is unavailable.
    """
    try:
        import trimesh
        import numpy as np

        # Convert to trimesh if it isn't already
        if not isinstance(mesh, trimesh.Trimesh):
            try:
                vertices = np.array(mesh.vertices)
                faces = np.array(mesh.faces)
                colors = None
                if hasattr(mesh, 'visual') and hasattr(mesh.visual, 'vertex_colors'):
                    colors = np.array(mesh.visual.vertex_colors)
                elif hasattr(mesh, 'vertex_color'):
                    colors = np.array(mesh.vertex_color)
                tm = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
                if colors is not None and len(colors) == len(vertices):
                    tm.visual = trimesh.visual.ColorVisuals(mesh=tm, vertex_colors=colors)
                mesh = tm
            except Exception as e:
                print(f"  [WARN] Mesh conversion failed: {e} — skipping island removal")
                return mesh

        components = mesh.split(only_watertight=False)
        if not components:
            return mesh

        # Pick the component whose centroid is closest to the origin —
        # TripoSR centres the subject at (0,0,0); shells orbit further out
        best = min(components, key=lambda m: np.linalg.norm(m.centroid))

        removed = len(components) - 1
        orig_verts = len(mesh.vertices)
        kept_verts = len(best.vertices)
        pct_kept = 100 * kept_verts / orig_verts if orig_verts else 0

        if removed > 0:
            best_dist = np.linalg.norm(best.centroid)
            print(f"  [CLEANUP] Removed {removed} floating component(s): "
                  f"{orig_verts} → {kept_verts} vertices ({pct_kept:.0f}% kept), "
                  f"centroid dist={best_dist:.3f}")
        else:
            print(f"  [CLEANUP] Mesh is single component ({orig_verts} vertices)")

        return best

    except ImportError:
        print("  [WARN] trimesh not installed — skipping floating geometry removal "
              "(install: pip install trimesh)")
        return mesh
    except Exception as e:
        print(f"  [WARN] Island removal failed: {e} — using original mesh")
        return mesh


def _strip_background_shell(mesh) -> object:
    """
    Remove the background shell that TripoSR generates around the character.

    TripoSR creates a watertight mesh. When the input image has a white
    background (even after rembg, fringe pixels remain near-white), TripoSR
    reconstructs those pixels as a large curved shell surrounding the subject.

    Two-pass approach:
    1. Vertex color filter: remove faces where ALL 3 vertices are near-white
       (R>0.75 AND G>0.75 AND B>0.75) — these belong to the background shell.
    2. Centroid filter: if vertex colors aren't available or shell survives,
       keep only the connected component whose centroid is closest to origin.

    Falls back silently if trimesh is unavailable.
    """
    try:
        import trimesh
        import numpy as np

        # Convert to trimesh
        if not isinstance(mesh, trimesh.Trimesh):
            try:
                vertices = np.array(mesh.vertices)
                faces = np.array(mesh.faces)
                colors = None
                if hasattr(mesh, 'visual') and hasattr(mesh.visual, 'vertex_colors'):
                    colors = np.array(mesh.visual.vertex_colors)
                elif hasattr(mesh, 'vertex_color'):
                    colors = np.array(mesh.vertex_color)
                tm = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
                if colors is not None and len(colors) == len(vertices):
                    tm.visual = trimesh.visual.ColorVisuals(mesh=tm, vertex_colors=colors)
                mesh = tm
            except Exception as e:
                print(f"  [STRIP] Conversion failed: {e}")
                return mesh

        orig_v = len(mesh.vertices)
        orig_f = len(mesh.faces)

        # ── Pass 1: vertex color filter ────────────────────────────────────
        try:
            if (hasattr(mesh.visual, 'vertex_colors') and
                    mesh.visual.vertex_colors is not None):

                vc = np.array(mesh.visual.vertex_colors, dtype=np.float32) / 255.0
                rgb = vc[:, :3]

                # Shell threshold: all channels > 0.75 = near-white background pixel
                SHELL_THRESH = 0.75
                is_shell = np.all(rgb > SHELL_THRESH, axis=1)

                # A face belongs to the shell if ALL 3 of its vertices are shell-colored
                faces = mesh.faces
                shell_face = (is_shell[faces[:, 0]] &
                              is_shell[faces[:, 1]] &
                              is_shell[faces[:, 2]])

                n_shell = int(shell_face.sum())
                n_keep = int((~shell_face).sum())

                if n_shell > 0 and n_keep > 50:
                    keep_faces = mesh.faces[~shell_face]
                    cleaned = trimesh.Trimesh(
                        vertices=mesh.vertices,
                        faces=keep_faces,
                        vertex_colors=vc,
                        process=True
                    )
                    pct = 100 * len(cleaned.vertices) / orig_v if orig_v else 0
                    print(f"  [STRIP] Color filter: removed {n_shell} shell faces, "
                          f"{len(cleaned.vertices)} verts remain ({pct:.0f}%)")
                    mesh = cleaned
                else:
                    print(f"  [STRIP] Color filter: {n_shell} shell faces found "
                          f"(threshold too strict or no vertex colors)")
        except Exception as e:
            print(f"  [STRIP] Color filter error: {e}")

        # ── Pass 2: centroid-based component selection ─────────────────────
        try:
            components = mesh.split(only_watertight=False)
            if len(components) > 1:
                best = min(components, key=lambda m: np.linalg.norm(m.centroid))
                removed = len(components) - 1
                print(f"  [STRIP] Component filter: kept 1/{len(components)} "
                      f"(centroid dist={np.linalg.norm(best.centroid):.3f}), "
                      f"removed {removed} component(s)")
                mesh = best
        except Exception as e:
            print(f"  [STRIP] Component filter error: {e}")

        print(f"  [STRIP] Final: {orig_v}v/{orig_f}f → "
              f"{len(mesh.vertices)}v/{len(mesh.faces)}f")
        return mesh

    except ImportError:
        print("  [STRIP] trimesh not installed, skipping cleanup")
        return mesh
    except Exception as e:
        print(f"  [STRIP] Failed: {e}")
        return mesh


def triposr_generate(image_path: Path, output_path: Path) -> bool:
    """Convert a concept image to 3D model using TripoSR.

    Pipeline:
      1. rembg  — remove background (handles RGB *and* RGBA concept art)
      2. crop   — tight crop to subject bounding box + small margin
      3. resize — scale subject to fill 85% of a 512×512 white canvas
      4. TripoSR — reconstruct 3D mesh from the clean masked image
      5. export — save as GLB with vertex colours
    """
    global _triposr_model
    try:
        import torch
        from PIL import Image

        # Try both import paths
        try:
            from tsr.system import TSR
        except ImportError:
            from TripoSR.tsr.system import TSR

        if _triposr_model is None:
            print("  Loading TripoSR model (first run, ~2GB download)...")
            _triposr_model = TSR.from_pretrained(
                "stabilityai/TripoSR",
                config_name="config.yaml",
                weight_name="model.ckpt",
            )
            _triposr_model.renderer.set_chunk_size(8192)
            _triposr_model.to("cuda")

        image = Image.open(image_path)

        # Step 1: remove background — always run rembg regardless of input mode.
        # ComfyUI concept art is RGB with a white/gradient background; without this
        # TripoSR reconstructs the background as a curved wall/dome shell artifact.
        image_rgba = _remove_background(image)

        # Step 2 & 3: crop tight + centre on white canvas
        image_rgb = _prepare_for_triposr(image_rgba)

        # Step 4: TripoSR inference (~15s on 12GB GPU)
        with torch.no_grad():
            scene_codes = _triposr_model([image_rgb], device="cuda")

        # Step 5: export as GLB
        meshes = _triposr_model.extract_mesh(scene_codes, has_vertex_color=True, resolution=256)
        mesh = meshes[0]

        # Step 6: remove shell geometry
        # Strategy A: remove faces where ALL 3 vertices have near-white vertex colors
        # (the background shell inherits the white canvas color, the character does not)
        # Strategy B: centroid-based component selection as fallback
        mesh = _strip_background_shell(mesh)

        mesh.export(str(output_path))
        return True

    except Exception as e:
        print(f"  [ERROR] TripoSR failed: {e}")
        return False


# =============================================================================
# Meshy.ai Backend (Cloud)
# =============================================================================

def meshy_available(api_key: str) -> bool:
    """Check if Meshy API key is set."""
    return bool(api_key)


def meshy_image_to_3d(api_key: str, image_path: Path, output_path: Path) -> bool:
    """Convert image to 3D using Meshy.ai image-to-3D API."""
    import base64

    image_data = base64.b64encode(image_path.read_bytes()).decode()
    ext = image_path.suffix.lower().lstrip(".")
    mime = f"image/{ext}" if ext != "jpg" else "image/jpeg"

    payload = json.dumps({
        "image_url": f"data:{mime};base64,{image_data}",
        "enable_pbr": True,
    }).encode()

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        # Create task
        req = urllib.request.Request(
            "https://api.meshy.ai/v2/image-to-3d",
            data=payload,
            headers=headers,
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=30)
        result = json.loads(resp.read())
        task_id = result.get("result")
        if not task_id:
            print(f"  [ERROR] No task_id from Meshy")
            return False

        print(f"  [MESHY] Task {task_id} created, polling...")

        # Poll for completion (typically 1-3 min)
        for attempt in range(120):
            time.sleep(5)
            poll_req = urllib.request.Request(
                f"https://api.meshy.ai/v2/image-to-3d/{task_id}",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            poll_resp = urllib.request.urlopen(poll_req, timeout=15)
            poll_data = json.loads(poll_resp.read())
            status = poll_data.get("status")

            if status == "SUCCEEDED":
                model_url = poll_data.get("model_urls", {}).get("glb")
                if model_url:
                    model_req = urllib.request.Request(model_url)
                    model_data = urllib.request.urlopen(model_req, timeout=60).read()
                    output_path.write_bytes(model_data)
                    return True
                print(f"  [ERROR] No GLB URL in Meshy response")
                return False
            elif status == "FAILED":
                print(f"  [ERROR] Meshy task failed: {poll_data.get('task_error', 'unknown')}")
                return False
            elif attempt % 6 == 0:
                progress = poll_data.get("progress", 0)
                print(f"    ... {status} ({progress}%)")

        print(f"  [ERROR] Meshy timed out after 10 minutes")
        return False

    except Exception as e:
        print(f"  [ERROR] Meshy request failed: {e}")
        return False


def meshy_text_to_3d(api_key: str, prompt: str, output_path: Path) -> bool:
    """Generate 3D model directly from text using Meshy.ai (skips concept art)."""
    payload = json.dumps({
        "mode": "preview",
        "prompt": prompt,
        "art_style": "low-poly",
        "negative_prompt": "blurry, realistic, photorealistic",
    }).encode()

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        req = urllib.request.Request(
            "https://api.meshy.ai/v2/text-to-3d",
            data=payload,
            headers=headers,
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=30)
        result = json.loads(resp.read())
        task_id = result.get("result")
        if not task_id:
            print(f"  [ERROR] No task_id from Meshy text-to-3D")
            return False

        print(f"  [MESHY] Text-to-3D task {task_id}, polling...")

        for attempt in range(120):
            time.sleep(5)
            poll_req = urllib.request.Request(
                f"https://api.meshy.ai/v2/text-to-3d/{task_id}",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            poll_resp = urllib.request.urlopen(poll_req, timeout=15)
            poll_data = json.loads(poll_resp.read())
            status = poll_data.get("status")

            if status == "SUCCEEDED":
                model_url = poll_data.get("model_urls", {}).get("glb")
                if model_url:
                    model_req = urllib.request.Request(model_url)
                    model_data = urllib.request.urlopen(model_req, timeout=60).read()
                    output_path.write_bytes(model_data)
                    return True
                return False
            elif status == "FAILED":
                print(f"  [ERROR] Meshy text-to-3D failed")
                return False
            elif attempt % 6 == 0:
                progress = poll_data.get("progress", 0)
                print(f"    ... {status} ({progress}%)")

        return False
    except Exception as e:
        print(f"  [ERROR] Meshy text-to-3D failed: {e}")
        return False


# =============================================================================
# Main
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="Convert concept art to 3D models")
    parser.add_argument("--backend", choices=["auto", "triposr", "meshy"], default="auto")
    parser.add_argument("--meshy-key", default=os.environ.get("MESHY_API_KEY", ""))
    parser.add_argument("--category", help="Only process this category")
    parser.add_argument("--id", help="Only process this asset ID")
    parser.add_argument("--text-to-3d", action="store_true",
                        help="Use text-to-3D (Meshy only, skips concept art requirement)")
    parser.add_argument("--input", help="Input concept image or directory (overrides default)")
    parser.add_argument("--output", help="Output directory (overrides default)")
    parser.add_argument("--force", action="store_true", help="Overwrite existing models")
    args = parser.parse_args()

    global OUTPUT_BASE, CONCEPTS_DIR
    if args.output:
        OUTPUT_BASE = Path(args.output)
        OUTPUT_BASE.mkdir(parents=True, exist_ok=True)
    if args.input:
        input_path = Path(args.input)
        if input_path.is_dir():
            CONCEPTS_DIR = input_path
        else:
            CONCEPTS_DIR = input_path.parent

    # Determine backend
    backend = args.backend
    if backend == "auto":
        if triposr_available():
            backend = "triposr"
            print("[INFO] Using TripoSR (local GPU)")
        elif meshy_available(args.meshy_key):
            backend = "meshy"
            print("[INFO] Using Meshy.ai (cloud)")
        else:
            print("[ERROR] No 3D generation backend available!")
            print("  Install TripoSR: pip install tsr torch")
            print("  Or set MESHY_API_KEY for cloud generation")
            sys.exit(1)
    elif backend == "triposr" and not triposr_available():
        print("[ERROR] TripoSR not available. Install: pip install tsr torch")
        sys.exit(1)
    elif backend == "meshy" and not meshy_available(args.meshy_key):
        print("[ERROR] MESHY_API_KEY not set")
        sys.exit(1)

    # Direct mode: --input points to a specific image file and --id is given
    # Process that single image without needing a manifest entry
    if args.input and args.id and Path(args.input).is_file():
        concept_path = Path(args.input)
        out_path = OUTPUT_BASE / f"{args.id}.glb"

        if out_path.exists() and not args.force:
            print(f"  [SKIP] {args.id}.glb — already exists (use --force to overwrite)")
            sys.exit(0)

        print(f"  [GEN] {args.id} (image-to-3D, direct mode)")
        if backend == "triposr":
            ok = triposr_generate(concept_path, out_path)
        else:
            ok = meshy_image_to_3d(args.meshy_key, concept_path, out_path)

        if ok:
            print(f"  [OK] {args.id}.glb")
            print(f"\n[DONE] Generated 1/1 3D models")
            print(f"  Output: {OUTPUT_BASE}")
            sys.exit(0)
        else:
            print(f"  [FAIL] {args.id}.glb")
            sys.exit(1)

    # Manifest mode: iterate over manifest entries
    manifest = load_manifest()
    total = 0
    success = 0

    for cat_name in CATEGORIES_3D:
        if args.category and cat_name != args.category:
            continue

        assets = manifest.get(cat_name, [])
        if not assets:
            continue

        print(f"\n{'='*60}")
        print(f"  3D Models: {cat_name} ({len(assets)} assets)")
        print(f"{'='*60}")

        out_dir = ensure_output_dir(cat_name)

        for asset in assets:
            asset_id = asset["id"]
            if args.id and asset_id != args.id:
                continue

            out_path = out_dir / f"{asset_id}.glb"
            if out_path.exists() and not args.force:
                print(f"  [SKIP] {cat_name}/{asset_id}.glb — already exists (use --force to overwrite)")
                total += 1
                success += 1
                continue

            concept_path = CONCEPTS_DIR / cat_name / f"{asset_id}.png"
            total += 1

            if args.text_to_3d and backend == "meshy":
                print(f"  [GEN] {cat_name}/{asset_id} (text-to-3D)")
                ok = meshy_text_to_3d(args.meshy_key, asset["prompt"], out_path)
            elif concept_path.exists():
                print(f"  [GEN] {cat_name}/{asset_id} (image-to-3D)")
                if backend == "triposr":
                    ok = triposr_generate(concept_path, out_path)
                else:
                    ok = meshy_image_to_3d(args.meshy_key, concept_path, out_path)
            else:
                print(f"  [WARN] No concept art for {cat_name}/{asset_id}, skipping")
                print(f"         Run generate_concepts.py first, or use --text-to-3d")
                continue

            if ok:
                success += 1
                print(f"  [OK] {cat_name}/{asset_id}.glb")

    print(f"\n[DONE] Generated {success}/{total} 3D models")
    print(f"  Output: {OUTPUT_BASE}")


if __name__ == "__main__":
    main()
