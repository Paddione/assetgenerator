#!/usr/bin/env python3
"""
Create Blender templates for sprite rendering.
Run with: blender --background --python create_templates.py -- --output /path/to/blend/

Each template provides camera, lighting, and render settings for a category.
The render_sprites.py script imports GLB models into these templates at runtime.
"""

import sys
import math

try:
    import bpy
    import mathutils
except ImportError:
    print("Must run inside Blender: blender --background --python create_templates.py -- --output DIR")
    sys.exit(1)

# Parse args after "--"
argv = sys.argv
if "--" in argv:
    argv = argv[argv.index("--") + 1:]
else:
    argv = []

import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, help="Output directory for .blend files")
args = parser.parse_args(argv)

OUTPUT_DIR = args.output

# =============================================================================
# Template definitions
# =============================================================================

TEMPLATES = {
    "character.blend": {
        "camera_distance": 3.0,
        "camera_angle_deg": 60,
        "camera_ortho_scale": 2.5,
        "render_resolution": 128,
        "key_light_energy": 3.0,
        "fill_light_energy": 1.5,
        "rim_light_energy": 2.0,
    },
    "weapon.blend": {
        "camera_distance": 2.0,
        "camera_angle_deg": 60,
        "camera_ortho_scale": 1.5,
        "render_resolution": 64,
        "key_light_energy": 4.0,
        "fill_light_energy": 2.0,
        "rim_light_energy": 2.5,
    },
    "item.blend": {
        "camera_distance": 2.5,
        "camera_angle_deg": 55,
        "camera_ortho_scale": 1.8,
        "render_resolution": 64,
        "key_light_energy": 3.5,
        "fill_light_energy": 2.0,
        "rim_light_energy": 2.0,
    },
    "cover.blend": {
        "camera_distance": 2.5,
        "camera_angle_deg": 60,
        "camera_ortho_scale": 2.0,
        "render_resolution": 64,
        "key_light_energy": 3.0,
        "fill_light_energy": 1.5,
        "rim_light_energy": 2.0,
    },
    "tile.blend": {
        "camera_distance": 2.0,
        "camera_angle_deg": 90,  # Pure top-down for tiles
        "camera_ortho_scale": 1.2,
        "render_resolution": 64,
        "key_light_energy": 3.0,
        "fill_light_energy": 2.5,
        "rim_light_energy": 1.0,
    },
    "ui.blend": {
        "camera_distance": 1.5,
        "camera_angle_deg": 0,   # Front-on for UI icons
        "camera_ortho_scale": 1.0,
        "render_resolution": 32,
        "key_light_energy": 4.0,
        "fill_light_energy": 3.0,
        "rim_light_energy": 1.5,
    },
}


def create_template(filename, cfg):
    """Create a single Blender template with camera, lights, and render settings."""
    # Reset to empty scene
    bpy.ops.wm.read_factory_settings(use_empty=True)

    scene = bpy.context.scene

    # --- Render settings ---
    scene.render.engine = 'BLENDER_EEVEE_NEXT' if bpy.app.version >= (4, 2, 0) else 'BLENDER_EEVEE'
    scene.render.resolution_x = cfg["render_resolution"]
    scene.render.resolution_y = cfg["render_resolution"]
    scene.render.film_transparent = True  # Transparent background
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'

    # --- Camera ---
    angle_rad = math.radians(cfg["camera_angle_deg"])
    dist = cfg["camera_distance"]

    # Camera position: orbit at angle from vertical
    cam_x = 0
    cam_y = -dist * math.sin(angle_rad)
    cam_z = dist * math.cos(angle_rad)

    cam_data = bpy.data.cameras.new("Camera")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = cfg["camera_ortho_scale"]
    cam_data.clip_start = 0.1
    cam_data.clip_end = 100

    cam_obj = bpy.data.objects.new("Camera", cam_data)
    scene.collection.objects.link(cam_obj)
    cam_obj.location = (cam_x, cam_y, cam_z)

    # Point camera at origin
    direction = mathutils.Vector((0, 0, 0)) - mathutils.Vector((cam_x, cam_y, cam_z))
    rot_quat = direction.to_track_quat('-Z', 'Y')
    cam_obj.rotation_euler = rot_quat.to_euler()

    scene.camera = cam_obj

    # --- 3-point lighting ---
    # Key light (main, upper right)
    key_data = bpy.data.lights.new("KeyLight", 'SUN')
    key_data.energy = cfg["key_light_energy"]
    key_obj = bpy.data.objects.new("KeyLight", key_data)
    scene.collection.objects.link(key_obj)
    key_obj.rotation_euler = (math.radians(50), math.radians(10), math.radians(-30))

    # Fill light (softer, left side)
    fill_data = bpy.data.lights.new("FillLight", 'SUN')
    fill_data.energy = cfg["fill_light_energy"]
    fill_obj = bpy.data.objects.new("FillLight", fill_data)
    scene.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = (math.radians(40), math.radians(-20), math.radians(45))

    # Rim light (back, accent)
    rim_data = bpy.data.lights.new("RimLight", 'SUN')
    rim_data.energy = cfg["rim_light_energy"]
    rim_obj = bpy.data.objects.new("RimLight", rim_data)
    scene.collection.objects.link(rim_obj)
    rim_obj.rotation_euler = (math.radians(-30), math.radians(0), math.radians(160))

    # --- Save ---
    import os
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    filepath = os.path.join(OUTPUT_DIR, filename)
    bpy.ops.wm.save_as_mainfile(filepath=filepath)
    print(f"  Created: {filepath}")


# =============================================================================
# Main
# =============================================================================

print(f"\nCreating {len(TEMPLATES)} Blender templates in {OUTPUT_DIR}\n")

for filename, cfg in TEMPLATES.items():
    create_template(filename, cfg)

print(f"\nDone! {len(TEMPLATES)} templates created.")
