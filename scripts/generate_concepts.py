#!/usr/bin/env python3
"""
Phase 1: Concept Art Generation
Generates 2D concept images for all assets using ComfyUI API or diffusers pipeline.
Falls back to local Stable Diffusion XL if ComfyUI is not available.

Usage:
    python generate_concepts.py [--comfyui-url URL] [--category CATEGORY] [--id ASSET_ID]
                                [--output DIR] [--prompt OVERRIDE_PROMPT]

    --comfyui-url   ComfyUI API endpoint (default: http://127.0.0.1:8188)
    --category      Generate only this category (characters, items, tiles, etc.)
    --id            Generate only this specific asset ID
    --output        Output base directory (overrides default)
    --prompt        Override prompt for single asset generation (use with --id)
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
OUTPUT_BASE = Path(__file__).parent.parent / "assets" / "concepts"
FORCE_OVERWRITE = False

# SDXL generation params
DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024
DEFAULT_STEPS = 40
DEFAULT_CFG = 9.0
NEGATIVE_PROMPT = (
    "blurry, low quality, watermark, text, signature, deformed, ugly, "
    "realistic photo, photorealistic, noisy, grainy, "
    "multiple views, multiple angles, character sheet, turnaround sheet, "
    "reference sheet, front and back, 3-view, orthographic views, "
    "side view, back view, collage, comparison, split image, "
    "model sheet, animation sheet, sprite sheet, multiple poses, "
    "white shoes, white sneakers, white clothing, white outfit, "
    "bright white, overexposed, washed out, pale colors, "
    "sitting, crouching, kneeling, bent knees, action pose, "
    "cropped figure, partial body, cut off, headshot, portrait, "
    "two characters, duplicate, mirror, split panel, diptych"
)

# Style suffix removed — asset prompts already contain full style direction
STYLE_SUFFIX = ""

# Categories that should keep their background (no rembg)
KEEP_BACKGROUND_CATEGORIES = {"tiles"}


def remove_background(image_path: Path) -> bool:
    """Remove background from a generated concept image using rembg."""
    try:
        from rembg import remove
        from PIL import Image

        img = Image.open(image_path)
        result = remove(img)
        result.save(image_path, "PNG")
        print(f"  [REMBG] Background removed: {image_path.name}")
        return True
    except ImportError:
        print("  [WARN] rembg not installed, skipping background removal")
        return False
    except Exception as e:
        print(f"  [WARN] Background removal failed: {e}")
        return False


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
# ComfyUI Backend
# =============================================================================

def comfyui_available(base_url: str) -> bool:
    """Check if ComfyUI API is reachable."""
    try:
        req = urllib.request.Request(f"{base_url}/system_stats", method="GET")
        urllib.request.urlopen(req, timeout=3)
        return True
    except (urllib.error.URLError, ConnectionError, TimeoutError):
        return False


def comfyui_generate(base_url: str, prompt: str, output_path: Path, width: int, height: int) -> bool:
    """Generate an image via ComfyUI API using a simple txt2img workflow."""
    workflow = {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": int(time.time() * 1000) % (2**32),
                "steps": DEFAULT_STEPS,
                "cfg": DEFAULT_CFG,
                "sampler_name": "dpmpp_2m",
                "scheduler": "karras",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
            },
        },
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"},
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt + STYLE_SUFFIX, "clip": ["4", 1]},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": NEGATIVE_PROMPT, "clip": ["4", 1]},
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]},
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"filename_prefix": output_path.stem, "images": ["8", 0]},
        },
    }

    payload = json.dumps({"prompt": workflow}).encode()
    req = urllib.request.Request(
        f"{base_url}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    try:
        resp = urllib.request.urlopen(req, timeout=300)
        result = json.loads(resp.read())
        prompt_id = result.get("prompt_id")
        if not prompt_id:
            print(f"  [ERROR] No prompt_id returned")
            return False

        # Poll for completion
        for _ in range(600):  # max 10 min
            time.sleep(1)
            history_req = urllib.request.Request(f"{base_url}/history/{prompt_id}")
            history_resp = urllib.request.urlopen(history_req, timeout=10)
            history = json.loads(history_resp.read())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                for node_id, node_output in outputs.items():
                    images = node_output.get("images", [])
                    if images:
                        img_info = images[0]
                        img_url = f"{base_url}/view?filename={img_info['filename']}&subfolder={img_info.get('subfolder', '')}&type={img_info.get('type', 'output')}"
                        img_req = urllib.request.Request(img_url)
                        img_data = urllib.request.urlopen(img_req, timeout=30).read()
                        output_path.write_bytes(img_data)
                        return True
                return False
        print(f"  [ERROR] Timed out waiting for ComfyUI")
        return False
    except Exception as e:
        print(f"  [ERROR] ComfyUI request failed: {e}")
        return False


# =============================================================================
# Diffusers (local SDXL) Backend
# =============================================================================

_diffusers_pipe = None

def diffusers_available() -> bool:
    """Check if diffusers + torch are installed with CUDA."""
    try:
        import torch
        import diffusers  # noqa: F401
        return torch.cuda.is_available()
    except ImportError:
        return False


# A-pose control image: standing figure with arms at ~45 degrees
# Pre-generated OpenPose skeleton for A-pose — used as ControlNet conditioning
# This is a minimal 18-keypoint skeleton encoded as a 512x768 black image with colored joints
APOSE_SKELETON_PATH = Path(__file__).parent.parent / "assets" / "apose_skeleton.png"

def _get_apose_skeleton(width: int, height: int):
    """Generate or load an A-pose OpenPose skeleton image for ControlNet conditioning."""
    from PIL import Image, ImageDraw
    import math

    # Create a black canvas
    img = Image.new("RGB", (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Scale keypoints to target resolution (designed for 512x768)
    sx, sy = width / 512, height / 768

    def pt(x, y):
        return (int(x * sx), int(y * sy))

    # OpenPose BODY_25 keypoints for A-pose — standing, arms at ~45 degrees
    # Coordinates tuned for full-body visible from head to feet
    joints = {
        "nose":       pt(256, 60),
        "neck":       pt(256, 120),
        "r_shoulder": pt(310, 140),
        "r_elbow":    pt(350, 220),
        "r_wrist":    pt(385, 290),
        "l_shoulder": pt(202, 140),
        "l_elbow":    pt(162, 220),
        "l_wrist":    pt(127, 290),
        "r_hip":      pt(290, 340),
        "r_knee":     pt(295, 490),
        "r_ankle":    pt(295, 650),
        "l_hip":      pt(222, 340),
        "l_knee":     pt(217, 490),
        "l_ankle":    pt(217, 650),
        "r_eye":      pt(270, 50),
        "l_eye":      pt(242, 50),
        "r_ear":      pt(280, 60),
        "l_ear":      pt(232, 60),
    }

    # Draw limb connections (lines between joints)
    limbs = [
        ("nose", "neck"), ("neck", "r_shoulder"), ("r_shoulder", "r_elbow"),
        ("r_elbow", "r_wrist"), ("neck", "l_shoulder"), ("l_shoulder", "l_elbow"),
        ("l_elbow", "l_wrist"), ("neck", "r_hip"), ("r_hip", "r_knee"),
        ("r_knee", "r_ankle"), ("neck", "l_hip"), ("l_hip", "l_knee"),
        ("l_knee", "l_ankle"), ("nose", "r_eye"), ("nose", "l_eye"),
        ("r_eye", "r_ear"), ("l_eye", "l_ear"),
    ]
    for a, b in limbs:
        if a in joints and b in joints:
            draw.line([joints[a], joints[b]], fill=(255, 255, 255), width=max(2, int(4 * sx)))

    # Draw joint dots
    r = max(3, int(5 * sx))
    for name, (x, y) in joints.items():
        draw.ellipse([x-r, y-r, x+r, y+r], fill=(0, 255, 0))

    return img


_diffusers_pipe = None

def diffusers_generate(prompt: str, output_path: Path, width: int, height: int) -> bool:
    """Generate using Juggernaut XL v9 — no ControlNet (avoids network hang).
    The A-pose is enforced via strong prompt terms instead.
    """
    global _diffusers_pipe
    try:
        import torch, os
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_OFFLINE"] = "1"
        from diffusers import StableDiffusionXLPipeline

        if _diffusers_pipe is None:
            print("  Loading Juggernaut XL v9...")
            _diffusers_pipe = StableDiffusionXLPipeline.from_pretrained(
                "RunDiffusion/Juggernaut-XL-v9",
                torch_dtype=torch.float16,
                variant="fp16",
                use_safetensors=True,
                local_files_only=True,
            )
            _diffusers_pipe.enable_model_cpu_offload()
            print("  Juggernaut XL v9 loaded.")

        image = _diffusers_pipe(
            prompt=prompt,
            negative_prompt=NEGATIVE_PROMPT,
            width=width,
            height=height,
            num_inference_steps=DEFAULT_STEPS,
            guidance_scale=DEFAULT_CFG,
        ).images[0]

        image.save(output_path)
        return True
    except Exception as e:
        print(f"  [ERROR] Diffusers generation failed: {e}")
        import traceback; traceback.print_exc()
        return False


# =============================================================================
# Generation Logic
# =============================================================================

def get_resolution(category: str, meta: dict, asset: dict = None) -> tuple[int, int]:
    """Determine generation resolution based on category."""
    if category == "characters":
        return DEFAULT_WIDTH, DEFAULT_HEIGHT  # High res for multi-frame characters
    elif category in ("items", "weapons"):
        return 768, 768
    elif category in ("tiles", "cover"):
        return 512, 512
    elif category == "ui":
        return 512, 512
    return DEFAULT_WIDTH, DEFAULT_HEIGHT


def generate_asset(asset: dict, category: str, meta: dict, backend: str, comfyui_url: str) -> bool:
    """Generate concept art for a single asset."""
    asset_id = asset["id"]
    out_dir = ensure_output_dir(category)
    out_path = out_dir / f"{asset_id}.png"

    if out_path.exists() and not FORCE_OVERWRITE:
        print(f"  [SKIP] {category}/{asset_id} — already exists")
        return True

    prompt = asset["prompt"]
    w, h = get_resolution(category, meta, asset)

    print(f"  [GEN] {category}/{asset_id} ({w}x{h})")

    if backend == "comfyui":
        ok = comfyui_generate(comfyui_url, prompt, out_path, w, h)
    else:
        ok = diffusers_generate(prompt, out_path, w, h)
    if ok and category not in KEEP_BACKGROUND_CATEGORIES:
        remove_background(out_path)
    return ok


def generate_character_concepts(char: dict, meta: dict, backend: str, comfyui_url: str) -> bool:
    """Generate concept art for a character — one overview + per-animation refs."""
    out_dir = ensure_output_dir("characters")
    char_id = char["id"]

    # Main character concept
    main_path = out_dir / f"{char_id}.png"
    if not main_path.exists() or FORCE_OVERWRITE:
        prompt = char["prompt"]
        w, h = get_resolution("characters", meta)
        print(f"  [GEN] characters/{char_id} (overview, {w}x{h})")
        if backend == "comfyui":
            ok = comfyui_generate(comfyui_url, prompt, main_path, w, h)
        else:
            ok = diffusers_generate(prompt, main_path, w, h)
        if not ok:
            return False
        remove_background(main_path)
    else:
        print(f"  [SKIP] characters/{char_id} — already exists")

    # NOTE: Per-animation reference sheet generation removed.
    # It was injecting animation reference sheet, multiple angles into prompts,
    # causing ComfyUI to generate multi-view character sheets instead of single front views.

    return True


def main():
    parser = argparse.ArgumentParser(description="Generate concept art for Arena assets")
    parser.add_argument("--comfyui-url", default="http://127.0.0.1:8188", help="ComfyUI API URL")
    parser.add_argument("--category", help="Only generate this category")
    parser.add_argument("--id", help="Only generate this asset ID")
    parser.add_argument("--backend", choices=["comfyui", "diffusers", "auto"], default="auto",
                        help="Generation backend (default: auto-detect)")
    parser.add_argument("--output", help="Output base directory (overrides default)")
    parser.add_argument("--prompt", dest="override_prompt", help="Override prompt for single asset generation")
    parser.add_argument("--force", action="store_true", help="Overwrite existing concepts")
    args = parser.parse_args()

    global OUTPUT_BASE, FORCE_OVERWRITE
    if args.output:
        OUTPUT_BASE = Path(args.output)
        OUTPUT_BASE.mkdir(parents=True, exist_ok=True)
    FORCE_OVERWRITE = args.force

    # Determine backend
    backend = args.backend
    if backend == "auto":
        if comfyui_available(args.comfyui_url):
            backend = "comfyui"
            print(f"[INFO] Using ComfyUI at {args.comfyui_url}")
        elif diffusers_available():
            backend = "diffusers"
            print("[INFO] Using local diffusers + SDXL")
        else:
            print("[ERROR] No generation backend available!")
            print("  Install ComfyUI or: pip install diffusers transformers torch accelerate")
            sys.exit(1)

    # Direct generation: when --id, --prompt, and --category are all provided,
    # skip manifest lookup and generate directly (used by adapter dispatch)
    if args.id and args.override_prompt and args.category:
        asset = {"id": args.id, "prompt": args.override_prompt}
        w, h = get_resolution(args.category, {})
        print(f"\n  [GEN] {args.category}/{args.id} ({w}x{h})")
        out_path = OUTPUT_BASE / f"{args.id}.png"
        if out_path.exists() and not args.force:
            print(f"  [SKIP] {args.category}/{args.id} — already exists (use --force to overwrite)")
        elif backend == "comfyui":
            ok = comfyui_generate(args.comfyui_url, args.override_prompt, out_path, w, h)
            if ok and args.category not in KEEP_BACKGROUND_CATEGORIES:
                remove_background(out_path)
            print(f"\n[DONE] {'Success' if ok else 'Failed'}")
            sys.exit(0 if ok else 1)
        else:
            ok = diffusers_generate(args.override_prompt, out_path, w, h)
            if ok and args.category not in KEEP_BACKGROUND_CATEGORIES:
                remove_background(out_path)
            print(f"\n[DONE] {'Success' if ok else 'Failed'}")
            sys.exit(0 if ok else 1)
        sys.exit(0)

    # Manifest-based generation: iterate over all assets in category
    manifest = load_manifest()
    meta = manifest.get("meta", {})

    # When --id and --prompt are both provided, override the asset's prompt in the manifest
    if args.id and args.override_prompt:
        for cat_name in ["characters", "weapons", "items", "tiles", "cover", "ui"]:
            for asset in manifest.get(cat_name, []):
                if asset["id"] == args.id:
                    asset["prompt"] = args.override_prompt

    # Category -> asset list mapping
    categories = {
        "characters": manifest.get("characters", []),
        "weapons":    manifest.get("weapons", []),
        "items":      manifest.get("items", []),
        "tiles":      manifest.get("tiles", []),
        "cover":      manifest.get("cover", []),
        "ui":         manifest.get("ui", []),
    }

    total = 0
    success = 0

    for cat_name, assets in categories.items():
        if args.category and cat_name != args.category:
            continue

        print(f"\n{'='*60}")
        print(f"  Category: {cat_name} ({len(assets)} assets)")
        print(f"{'='*60}")

        for asset in assets:
            if args.id and asset["id"] != args.id:
                continue

            total += 1
            if cat_name == "characters":
                ok = generate_character_concepts(asset, meta, backend, args.comfyui_url)
            else:
                ok = generate_asset(asset, cat_name, meta, backend, args.comfyui_url)
            if ok:
                success += 1

    print(f"\n[DONE] Generated {success}/{total} concept images")
    print(f"  Output: {OUTPUT_BASE}")


if __name__ == "__main__":
    main()
