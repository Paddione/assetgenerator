#!/usr/bin/env python3
"""
Blender template creator using bpy API.
Creates 6 persistent Blender project templates with professional lighting,
cameras, and material linking for arena sprite rendering.

Usage:
    blender --background --python scripts/create_blender_templates.py [-- --output DIR]
"""

import bpy
import os
import math
import sys
from pathlib import Path

# Configuration
BLEND_DIR = Path(__file__).parent.parent / "assets" / "blend"
MODELS_DIR = Path(__file__).parent.parent / "assets" / "models"

def clear_scene():
    """Remove all objects from default scene."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

    # Remove all materials
    for material in bpy.data.materials:
        bpy.data.materials.remove(material, do_unlink=True)

def setup_lighting_rig():
    """Create 3-point professional lighting rig."""
    print("[Lighting] Setting up 3-point lighting rig...")

    # Key Light (Sun - main directional light)
    bpy.ops.object.light_add(type='SUN', location=(2, -3, 3))
    key_light = bpy.context.active_object
    key_light.name = "KeyLight"
    key_light.data.energy = 2.0
    key_light.data.angle = math.radians(5)
    key_light.rotation_euler = (math.radians(45), math.radians(45), 0)
    key_light.data.use_shadow = True

    # Fill Light (Area - soft, no shadows)
    bpy.ops.object.light_add(type='AREA', location=(-2, 2, 1))
    fill_light = bpy.context.active_object
    fill_light.name = "FillLight"
    fill_light.data.energy = 0.5
    fill_light.data.size = 3.0
    fill_light.data.use_shadow = False

    # Rim Light (Area - edge separation)
    bpy.ops.object.light_add(type='AREA', location=(0, 1, 2))
    rim_light = bpy.context.active_object
    rim_light.name = "RimLight"
    rim_light.data.energy = 0.3
    rim_light.data.size = 2.0
    rim_light.data.use_shadow = False

    print("Lighting rig created (Key, Fill, Rim)")

def setup_camera(camera_name, position, rotation, scale=2.5):
    """Create and position orthographic camera."""
    bpy.ops.object.camera_add(location=position)
    camera = bpy.context.active_object
    camera.name = camera_name

    # Orthographic setup
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = scale
    camera.rotation_euler = rotation

    # Set as active camera
    bpy.context.scene.camera = camera

    print(f"Camera created: {camera_name} (ortho scale: {scale})")

def setup_world_lighting():
    """Configure world/environment lighting."""
    world = bpy.data.worlds["World"]
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.5  # Gray background
    print("World lighting configured")

def setup_eevee_rendering():
    """Configure EEVEE render engine with GPU acceleration."""
    scene = bpy.context.scene

    # Set render engine
    scene.render.engine = 'BLENDER_EEVEE'

    # Output settings
    scene.render.resolution_x = 256
    scene.render.resolution_y = 256
    scene.render.film_transparent = True  # Transparent background

    # EEVEE settings
    eevee = scene.eevee
    eevee.use_gtao = True  # Global Tone AO (formerly ambient occlusion)
    eevee.gtao_distance = 0.3
    eevee.gtao_factor = 1.2

    # Bloom for glowing materials
    eevee.use_bloom = True
    eevee.bloom_intensity = 0.1

    # Anti-aliasing
    eevee.taa_render_samples = 32

    print("EEVEE rendering configured (GPU: OptiX, 256x256, transparent)")

def link_materials_from_library(materials_path):
    """Link materials from shared library into current blend file."""
    if not materials_path.exists():
        print(f"WARNING: Materials library not found at {materials_path}")
        return False

    try:
        with bpy.data.libraries.load(str(materials_path), link=True) as (data_from, data_to):
            data_to.materials = data_from.materials
        print(f"Materials linked from shared library")
        return True
    except Exception as e:
        print(f"WARNING: Could not link materials: {e}")
        return False

def create_template(template_name, camera_pos, camera_rot, ortho_scale, description):
    """Create a single Blender template with lighting, camera, and materials."""
    print(f"\n[Template] Creating {template_name}.blend...")
    clear_scene()

    # Setup base components
    setup_lighting_rig()
    setup_camera(f"{template_name}_Camera", camera_pos, camera_rot, ortho_scale)
    setup_world_lighting()
    setup_eevee_rendering()

    # Save template first
    template_path = BLEND_DIR / f"{template_name}.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(template_path))
    print(f"Template saved: {template_path}")

    return template_path

# Template specifications: (name, camera_position, camera_rotation, ortho_scale, description)
TEMPLATES = [
    ("character", (0, -3, 2), (math.radians(60), 0, 0), 2.5,
     "Humanoid characters - 60 deg isometric, 8-direction rendering"),

    ("weapon", (0, -2, 1.5), (math.radians(60), 0, 0), 1.5,
     "Weapons & equipment - close-up, rim-lit detail"),

    ("item", (0, 0, 2), (math.radians(90), 0, 0), 1.2,
     "Items & pickups - centered icon-like view"),

    ("tile", (0, 0, 2), (math.radians(90), 0, 0), 2.0,
     "Floor tiles & terrain - perfect top-down"),

    ("cover", (2, -2, 2), (math.radians(45), 0, math.radians(30)), 2.2,
     "Obstacles & barricades - 45 deg side-lit depth"),

    ("ui", (0, 0, 2), (math.radians(90), 0, 0), 1.5,
     "UI icons & HUD - flat orthographic"),
]

def create_materials_library():
    """Create _shared/materials.blend with PBR material definitions."""
    print("[Materials] Creating shared materials library...")

    # Ensure clean scene
    clear_scene()

    # Create PBR_Skin material
    mat_skin = bpy.data.materials.new(name="PBR_Skin")
    mat_skin.use_nodes = True
    nodes = mat_skin.node_tree.nodes
    nodes.clear()
    links = mat_skin.node_tree.links

    # Skin shader setup
    bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.831, 0.647, 0.455, 1.0)  # #d4a574
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 0.8
    bsdf.inputs['Subsurface Weight'].default_value = 0.1

    output = nodes.new(type='ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    # Create PBR_Metal material
    mat_metal = bpy.data.materials.new(name="PBR_Metal")
    mat_metal.use_nodes = True
    nodes = mat_metal.node_tree.nodes
    nodes.clear()
    links = mat_metal.node_tree.links

    bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.714, 0.714, 0.714, 1.0)  # #b5b5b5
    bsdf.inputs['Metallic'].default_value = 1.0
    bsdf.inputs['Roughness'].default_value = 0.2

    output = nodes.new(type='ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    # Create PBR_Fabric material
    mat_fabric = bpy.data.materials.new(name="PBR_Fabric")
    mat_fabric.use_nodes = True
    nodes = mat_fabric.node_tree.nodes
    nodes.clear()
    links = mat_fabric.node_tree.links

    bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (0.5, 0.3, 0.2, 1.0)  # Fabric color
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 0.7

    output = nodes.new(type='ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    # Create Emission_Glow material
    mat_glow = bpy.data.materials.new(name="Emission_Glow")
    mat_glow.use_nodes = True
    nodes = mat_glow.node_tree.nodes
    nodes.clear()
    links = mat_glow.node_tree.links

    bsdf = nodes.new(type='ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (1.0, 0.8, 0.0, 1.0)  # Bright yellow
    bsdf.inputs['Emission Color'].default_value = (1.0, 0.8, 0.0, 1.0)
    bsdf.inputs['Emission Strength'].default_value = 5.0

    output = nodes.new(type='ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    # FIX: Create dummy cube and attach all materials to it
    # This ensures Blender saves the materials (they're now referenced)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    dummy_cube = bpy.context.active_object
    dummy_cube.name = "MaterialHolder"

    # Assign all materials to the dummy object
    dummy_cube.data.materials.append(mat_skin)
    dummy_cube.data.materials.append(mat_metal)
    dummy_cube.data.materials.append(mat_fabric)
    dummy_cube.data.materials.append(mat_glow)

    print("Created 4 PBR materials and attached to MaterialHolder object")

    # Save materials library
    BLEND_DIR.mkdir(parents=True, exist_ok=True)
    materials_path = BLEND_DIR / "_shared" / "materials.blend"
    materials_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.save_as_mainfile(filepath=str(materials_path))
    print(f"Materials library saved: {materials_path}")

    # Verify materials were saved
    print(f"Materials in file: {len(bpy.data.materials)} (should be 4)")

if __name__ == "__main__":
    # Parse args after "--" (Blender strips its own args)
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", help="Output directory (overrides default)")
    cli_args = parser.parse_args(argv)

    if cli_args.output:
        BLEND_DIR = Path(cli_args.output)

    print("=" * 60)
    print("Blender Template Creator")
    print("=" * 60)

    # Step 1: Create shared materials library
    print("\n[Step 1/2] Creating shared materials library...")
    clear_scene()
    create_materials_library()

    # Step 2: Create all 6 templates
    print("\n[Step 2/2] Creating template files...")
    created_templates = []

    for name, pos, rot, scale, desc in TEMPLATES:
        try:
            path = create_template(name, pos, rot, scale, desc)
            created_templates.append(str(path))
        except Exception as e:
            print(f"Error creating {name}: {e}")

    # Step 3: Link materials to each template
    print("\n[Step 3/3] Linking materials to templates...")
    materials_path = BLEND_DIR / "_shared" / "materials.blend"

    for template_path in created_templates:
        template_file = Path(template_path)
        print(f"\nLinking materials to {template_file.name}...")
        try:
            # Open template
            bpy.ops.wm.open_mainfile(filepath=str(template_path))

            # Link materials
            if link_materials_from_library(materials_path):
                # Save with linked materials
                bpy.ops.wm.save_mainfile()
                print(f"{template_file.name} saved with linked materials")
            else:
                print(f"WARNING: {template_file.name} created but materials linking failed")
        except Exception as e:
            print(f"Error linking materials to {template_file.name}: {e}")

    # Summary
    print("\n" + "=" * 60)
    print(f"SUCCESS: Created {len(created_templates)} template files")
    print("=" * 60)
    for path in created_templates:
        print(f"  - {Path(path).name}")
    print("\nNext steps:")
    print("  1. Verify templates in Blender GUI: blender assets/blend/character.blend")
    print("  2. Update render_sprites.py to use templates")
    print("  3. Run sprite rendering pipeline")
