#!/usr/bin/env python3
"""
Phase 3: Blender Sprite Rendering
Imports 3D models (.glb) and renders them as 2D sprite frames from an orthographic
top-down camera at 60 degree angle, producing individual PNGs for sprite sheet packing.

Supports both static (unrigged) and rigged models. Rigged models get per-pose bone
rotations applied before rendering, producing visually distinct weapon stances.

Usage:
    blender --background --python render_sprites.py -- [--category CATEGORY] [--id ASSET_ID]
                                                       [--model PATH] [--template PATH] [--output DIR]
                                                       [--poses stand,gun,machine,reload,hold,silencer]
                                                       [--force]

Note: Must be run via Blender's Python interpreter. The script uses Blender's bpy module.
"""

import json
import math
import os
import sys
from pathlib import Path

# When run from Blender, bpy is available
try:
    import bpy
    import mathutils
    IN_BLENDER = True
except ImportError:
    IN_BLENDER = False

MANIFEST_PATH = Path(__file__).parent.parent / "assets" / "manifest.json"
MODELS_DIR = Path(__file__).parent.parent / "assets" / "models"
BLEND_DIR = Path(__file__).parent.parent / "assets" / "blend"
OUTPUT_BASE = Path(__file__).parent.parent / "assets" / "renders"

# Render settings
CAMERA_ANGLE_DEG = 60  # Top-down angle (90 = pure top-down, 0 = side view)
CAMERA_DISTANCE = 3.0
RENDER_RESOLUTION = 256  # Render at 4x target (256→64px), matches visual-config.json
BG_TRANSPARENT = True

# Direction angles (8 directions, clockwise from North)
DIRECTIONS = {
    "N":  0,
    "NE": 45,
    "E":  90,
    "SE": 135,
    "S":  180,
    "SW": 225,
    "W":  270,
    "NW": 315,
}

# ---------------------------------------------------------------------------
# Pose presets — bone rotation overrides for each weapon stance.
# Angles are in degrees, applied as local Euler XYZ deltas from rest pose.
# Bone names match the 21-bone skeleton from simple_rig.py.
#
# Convention: X = pitch (forward/back), Y = roll, Z = yaw (left/right)
# Positive X on arms = raise forward; positive Z on right arm = swing outward
# ---------------------------------------------------------------------------
POSE_PRESETS = {
    "stand": {
        # Rest pose — no overrides, arms relaxed at sides
    },
    "walk": {
        # Walking mid-stride: left leg forward, right back, opposite arm swing
        "upper_leg.L": (-25, 0, 0),
        "lower_leg.L": (15, 0, 0),
        "upper_leg.R": (20, 0, 0),
        "lower_leg.R": (-10, 0, 0),
        "upper_arm.R": (-25, 0, -5),
        "forearm.R":   (-15, 0, 0),
        "upper_arm.L": (15, 0, 5),
        "spine":       (-5, 0, 0),
    },
    "gun": {
        # Pistol stance: right arm fully extended, left clearly at side
        # Exaggerated for 64px readability (need 20°+ delta from other poses)
        "upper_arm.R": (-75, 0, -25),
        "forearm.R":   (-15, 0, 0),
        "hand.R":      (-10, 0, 0),
        "upper_arm.L": (-5, 0, 15),
        "spine":       (-10, 0, 0),
    },
    "machine": {
        # Machine gun: both arms far forward, wide grip, heavy lean
        "upper_arm.R": (-65, 0, -35),
        "forearm.R":   (-45, 0, 0),
        "hand.R":      (-15, 0, 0),
        "upper_arm.L": (-65, 0, 35),
        "forearm.L":   (-45, 0, 0),
        "hand.L":      (-15, 0, 0),
        "spine":       (-15, 0, 0),
        "chest":       (-8, 0, 0),
    },
    "reload": {
        # Reloading: arms pulled tight to chest, head down — clearly distinct
        "upper_arm.R": (-30, 0, -5),
        "forearm.R":   (-95, 0, 0),
        "hand.R":      (-25, 0, 0),
        "upper_arm.L": (-25, 0, 10),
        "forearm.L":   (-100, 0, 0),
        "hand.L":      (-15, 0, 0),
        "spine":       (-18, 0, 0),
        "neck":        (-20, 0, 0),
    },
    "hold": {
        # Two-handed weapon at hip: arms lower and wider than gun/machine
        "upper_arm.R": (-20, 0, -25),
        "forearm.R":   (-40, 0, 0),
        "hand.R":      (-10, 0, 0),
        "upper_arm.L": (-20, 0, 25),
        "forearm.L":   (-40, 0, 0),
        "hand.L":      (-10, 0, 0),
        "spine":       (-3, 0, 0),
    },
    "silencer": {
        # Stealth: deep crouch, weapon high and forward — max visual difference
        "upper_arm.R": (-80, 0, -15),
        "forearm.R":   (-20, 0, 0),
        "hand.R":      (-5, 0, 0),
        "upper_arm.L": (-40, 0, 20),
        "forearm.L":   (-55, 0, 0),
        "hand.L":      (-10, 0, 0),
        "spine":       (-20, 0, 0),
        "chest":       (-8, 0, 0),
        "upper_leg.L": (-18, 0, 0),
        "upper_leg.R": (-18, 0, 0),
        "lower_leg.L": (25, 0, 0),
        "lower_leg.R": (25, 0, 0),
    },
}


def find_armature(objects):
    """Find the armature object among imported objects (or their parents)."""
    for obj in objects:
        if obj.type == 'ARMATURE':
            return obj
    # Check parents — rigged GLBs often have armature as root
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            return obj
    return None


def apply_pose(armature, pose_name):
    """Apply bone rotation overrides for the given pose preset.

    Switches the armature to POSE mode, resets all bones to rest,
    then applies the rotation deltas from POSE_PRESETS.
    Supports multiple bone naming conventions (simple_rig.py and MCP/Rigify).
    """
    preset = POSE_PRESETS.get(pose_name, {})

    # Bone name aliases: maps preset names → alternative names found in different rigs
    BONE_ALIASES = {
        "upper_leg.L": "thigh.L",
        "upper_leg.R": "thigh.R",
        "lower_leg.L": "shin.L",
        "lower_leg.R": "shin.R",
    }

    # Ensure we're working with the armature
    bpy.context.view_layer.objects.active = armature

    # Reset all pose bones to rest position
    for pb in armature.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)

    # Apply preset rotations
    for bone_name, (rx, ry, rz) in preset.items():
        pb = armature.pose.bones.get(bone_name)
        # Try alias if primary name not found
        if not pb and bone_name in BONE_ALIASES:
            pb = armature.pose.bones.get(BONE_ALIASES[bone_name])
        if pb:
            pb.rotation_mode = 'XYZ'
            pb.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
        else:
            print(f"    [WARN] Bone '{bone_name}' not found in armature")

    # Force dependency graph update so mesh deforms before render
    bpy.context.view_layer.update()
    if pose_name != "stand":
        print(f"    Applied pose: {pose_name} ({len(preset)} bone overrides)")


def load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        return {"meta": {}, "characters": [], "weapons": [], "items": [], "tiles": [], "cover": [], "ui": []}
    with open(MANIFEST_PATH) as f:
        return json.load(f)


def ensure_output_dir(*parts: str) -> Path:
    out = OUTPUT_BASE
    for p in parts:
        out = out / p
    out.mkdir(parents=True, exist_ok=True)
    return out


def get_template_path(category: str) -> Path:
    """Get the Blender template path for an asset category."""
    template_map = {
        'characters': 'character.blend',
        'weapons': 'weapon.blend',
        'items': 'item.blend',
        'cover': 'cover.blend',
        'tiles': 'tile.blend',
        'ui': 'ui.blend',
    }

    template_file = template_map.get(category, 'character.blend')
    template_path = BLEND_DIR / template_file

    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template_path}")

    return template_path


def load_blender_template(template_path: Path):
    """Load a Blender template file and prepare for rendering."""
    bpy.ops.wm.open_mainfile(filepath=str(template_path))
    print(f"  Loaded template: {template_path.name}")

    # Ensure camera is set
    if not bpy.context.scene.camera:
        # Find any camera in scene
        for obj in bpy.data.objects:
            if obj.type == 'CAMERA':
                bpy.context.scene.camera = obj
                break

    return bpy.context.scene


def get_model_bounds(objects):
    """Calculate world-space bounding box for a list of mesh objects."""
    min_co = mathutils.Vector((float('inf'),) * 3)
    max_co = mathutils.Vector((float('-inf'),) * 3)
    found = False
    for obj in objects:
        if obj.type != 'MESH':
            continue
        found = True
        for corner in obj.bound_box:
            world_co = obj.matrix_world @ mathutils.Vector(corner)
            for i in range(3):
                min_co[i] = min(min_co[i], world_co[i])
                max_co[i] = max(max_co[i], world_co[i])
    if not found:
        return mathutils.Vector((0, 0, 0)), mathutils.Vector((1, 1, 1))
    return min_co, max_co


def hex_to_rgb(hex_color):
    """Convert hex color like #00f2ff to (r, g, b) floats 0-1."""
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 6:
        r = int(hex_color[0:2], 16) / 255.0
        g = int(hex_color[2:4], 16) / 255.0
        b = int(hex_color[4:6], 16) / 255.0
        return (r, g, b)
    return (0.2, 0.5, 0.8)  # fallback blue


def setup_asset_material(objects, accent_color=None):
    """Create a stylized flat material for game character sprites.

    TripoSR vertex colors are unreliable — only the front-facing vertices
    have good colors from the concept image; back/side vertices are grey
    hallucinations. Using those vertex colors directly makes side/back
    sprite frames look grey.

    Instead we use a flat principled BSDF with the character's accent color
    as the base. This gives consistent, readable color from all 8 directions.
    The low-poly stylized look this produces is actually MORE appropriate for
    a game sprite than TripoSR's noisy vertex colors.
    """
    mat = bpy.data.materials.new(name="AssetMat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Roughness'].default_value = 0.7
    try:
        bsdf.inputs['Specular IOR Level'].default_value = 0.1
    except KeyError:
        pass  # older Blender versions

    output = nodes.new('ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    # Set base color from accent color, or use vertex colors as fallback
    if accent_color:
        rgb = hex_to_rgb(accent_color) if isinstance(accent_color, str) else accent_color
        bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        print(f"    Applied accent color material: {accent_color}")
    else:
        # Fallback: try vertex colors, else use dark blue-grey
        attr_node = nodes.new('ShaderNodeVertexColor')
        attr_node.layer_name = ""
        links.new(attr_node.outputs['Color'], bsdf.inputs['Base Color'])
        print(f"    Applied vertex color material (no accent color provided)")

    for obj in objects:
        if obj.type != 'MESH':
            continue
        obj.data.materials.clear()
        obj.data.materials.append(mat)


# Keep old name as alias for backward compatibility
def setup_vertex_color_material(objects):
    setup_asset_material(objects, accent_color=None)


def normalize_model(pivot, objects):
    """Center, scale, and orient the model to fit the camera frame."""
    bpy.context.view_layer.update()
    min_co, max_co = get_model_bounds(objects)
    size = max_co - min_co

    # Fix orientation: if tallest axis is Y (Y-up model), rotate to Z-up
    if size.y > size.z and size.y > size.x:
        pivot.rotation_euler.x = math.radians(-90)
        bpy.context.view_layer.update()
        min_co, max_co = get_model_bounds(objects)
        size = max_co - min_co
        print(f"    Corrected Y-up → Z-up orientation")
    # If tallest axis is X, rotate around Y
    elif size.x > size.z and size.x > size.y:
        pivot.rotation_euler.y = math.radians(90)
        bpy.context.view_layer.update()
        min_co, max_co = get_model_bounds(objects)
        size = max_co - min_co
        print(f"    Corrected X-up → Z-up orientation")

    center = (min_co + max_co) / 2

    # Move pivot so model is centered at origin, sitting on ground plane (Z=0)
    pivot.location.x = -center.x
    pivot.location.y = -center.y
    pivot.location.z = -min_co.z  # Bottom of model at Z=0

    # Scale to fit within ~2 units tall (matches ortho_scale=2.5 camera)
    max_dim = max(size.x, size.y, size.z)
    scale_factor = 1.0
    if max_dim > 0:
        target_size = 1.2  # Conservative size to prevent camera clipping from side views
        # Note: TripoSR models can have deep Z axis after Y-up correction,
        # so we need enough margin for the ortho camera (ortho_scale=2.5)
        scale_factor = target_size / max_dim
        pivot.scale = (scale_factor, scale_factor, scale_factor)

    bpy.context.view_layer.update()
    print(f"    Model bounds: {tuple(round(x,2) for x in size)}, scale: {round(scale_factor, 3)}")


def link_model_to_template(model_path: Path, position=(0, 0, 0)):
    """Import a 3D model, apply vertex colors, and normalize to fit camera.

    Returns (outer_pivot, armature_or_None). If the model has an armature
    (rigged GLB), the armature is returned so poses can be applied.
    """
    model_path = Path(model_path)
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    # Use Blender's import for .glb files
    bpy.ops.import_scene.gltf(filepath=str(model_path))

    # Get the imported objects
    imported = [obj for obj in bpy.context.selected_objects]
    if not imported:
        return None, None

    # Check for armature (rigged model)
    armature = find_armature(imported)
    mesh_objects = [obj for obj in imported if obj.type == 'MESH']
    # Also grab meshes parented to the armature that weren't in selection
    if armature:
        for child in armature.children:
            if child.type == 'MESH' and child not in mesh_objects:
                mesh_objects.append(child)

    # Two-level pivot: inner for orientation/scale, outer for direction rotation
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=position)
    inner_pivot = bpy.context.object
    inner_pivot.name = "ModelInnerPivot"

    # Parent everything to inner pivot (armature if rigged, else raw meshes)
    if armature:
        armature.parent = inner_pivot
        print(f"  Rigged model: {len(armature.pose.bones)} bones detected")
    else:
        for obj in imported:
            obj.parent = inner_pivot

    bpy.ops.object.empty_add(type='PLAIN_AXES', location=position)
    outer_pivot = bpy.context.object
    outer_pivot.name = "ModelPivot"
    inner_pivot.parent = outer_pivot

    # Material strategy: preserve existing materials whenever possible.
    # Only replace with vertex color shader for truly material-less models.
    has_any_materials = any(
        mat for obj in mesh_objects if obj.type == 'MESH'
        for mat in obj.data.materials if mat
    )

    if has_any_materials:
        print(f"  Keeping existing materials ({sum(len(o.data.materials) for o in mesh_objects if o.type == 'MESH')} material slots)")
    else:
        has_vertex_colors = any(obj.data.color_attributes for obj in mesh_objects if obj.type == 'MESH')
        if has_vertex_colors:
            print(f"  Applying vertex color material (no materials, has vertex colors)")
            setup_vertex_color_material(mesh_objects)
        else:
            print(f"  Applying default grey material (no materials or vertex colors)")
            setup_asset_material(mesh_objects, accent_color="#888888")

    # Normalize: center, scale, orient to fit camera frame (applied to inner pivot)
    normalize_model(inner_pivot, mesh_objects)

    print(f"  Linked model: {model_path.name}")
    return outer_pivot, armature


def clear_model():
    """Remove all mesh objects, armatures, and empties (keep camera + lights)."""
    keep_types = {'CAMERA', 'LIGHT'}
    bpy.ops.object.select_all(action='DESELECT')
    for obj in bpy.data.objects:
        if obj.type not in keep_types:
            obj.select_set(True)
    bpy.ops.object.delete()
    # Clean up orphaned armature data blocks
    for arm in bpy.data.armatures:
        if arm.users == 0:
            bpy.data.armatures.remove(arm)




def parent_lights_to_pivot(pivot):
    """Parent all scene lights to the outer pivot so lighting rotates with the model.

    Without this, lights are fixed in the template while only the model rotates.
    This causes N/NE directions to receive grazing-angle lighting (back-lit), producing
    artifacts, lost detail, and inconsistent silhouettes across directions.
    """
    parented = 0
    for obj in bpy.data.objects:
        if obj.type == 'LIGHT':
            obj.parent = pivot
            parented += 1
    if parented:
        print(f"  Parented {parented} lights to model pivot (uniform directional lighting)")


def configure_camera_framing(scene, target_z=0.5, ortho_scale=2.0):
    """Position the orthographic camera to frame a normalized model.

    The model is centered at origin with bottom at Z=0 and height ~1.2 units.
    Camera is positioned for a 60 degree isometric view looking at (0, 0, target_z).
    """
    cam = scene.camera
    if not cam:
        return

    angle_rad = math.radians(CAMERA_ANGLE_DEG)
    distance = CAMERA_DISTANCE

    cam.location.x = 0
    cam.location.y = -distance * math.cos(angle_rad)
    cam.location.z = target_z + distance * math.sin(angle_rad)
    cam.rotation_euler = (angle_rad, 0, 0)

    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = ortho_scale
    bpy.context.view_layer.update()
    print(f"  Camera: 60° isometric, target Z={target_z}, ortho_scale={ortho_scale}")


def configure_alpha_rendering(scene, use_cycles=False):
    """Set render settings for clean transparent edges.

    Ensures film transparency is enabled, uses overscan to avoid edge clipping,
    and sets color management for accurate alpha compositing.

    If use_cycles=True, switches to Cycles CPU renderer (needed for PBR
    textured models when EEVEE GPU is unavailable in background mode).
    """
    scene.render.film_transparent = True
    scene.render.resolution_x = RENDER_RESOLUTION
    scene.render.resolution_y = RENDER_RESOLUTION
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '16'

    # Always use EEVEE (Cycles fails in WSL Blender 4.0 — no OIDN, no texture support)
    scene.render.engine = 'BLENDER_EEVEE'
    if hasattr(scene, 'eevee'):
        scene.eevee.use_overscan = True
        scene.eevee.overscan_size = 10  # 10% margin beyond frame

    print(f"  Alpha rendering: {RENDER_RESOLUTION}px, 16-bit RGBA")


def attach_weapon_prop(armature, pose_name, weapon_model_path=None):
    """Attach a weapon shape to the right hand bone for weapon poses.

    If weapon_model_path is provided, imports a real GLB weapon model.
    Otherwise falls back to procedural cube/cylinder geometry.

    At 64px, bone rotations alone can't convey 'holding a weapon' — the weapon
    geometry itself needs to be visible.
    """
    if pose_name in ("stand", "walk"):
        return  # No weapon in idle/walk poses

    hand_bone = armature.pose.bones.get("hand.R")
    if not hand_bone:
        return

    # Clean up any previous weapon props from this pose
    for obj in list(bpy.data.objects):
        if obj.name.startswith(f"WeaponProp_{pose_name}"):
            bpy.data.objects.remove(obj, do_unlink=True)

    # --- Real weapon model (from Sketchfab or other source) ---
    if weapon_model_path and os.path.exists(weapon_model_path):
        bpy.ops.import_scene.gltf(filepath=weapon_model_path)
        imported = [o for o in bpy.context.selected_objects if o.type == 'MESH']
        if imported:
            weapon = imported[0]
            weapon.name = f"WeaponProp_{pose_name}"
            # Normalize scale to fit hand (largest dim = 0.3 BU)
            max_dim = max(weapon.dimensions)
            if max_dim > 0:
                scale_factor = 0.3 / max_dim
                weapon.scale *= scale_factor
            weapon.parent = armature
            weapon.parent_type = 'BONE'
            weapon.parent_bone = "hand.R"
            weapon.location = (0.15, 0, 0)
            # Parent any other imported objects to main weapon
            for obj in imported[1:]:
                obj.parent = weapon
            bpy.context.view_layer.update()
            print(f"    Attached weapon model: {pose_name} ({weapon_model_path})")
            return

    # --- Fallback: procedural geometry ---
    # Weapon dimensions per pose (length, width, height)
    weapon_shapes = {
        "gun":      (0.20, 0.06, 0.06),   # Pistol
        "machine":  (0.30, 0.07, 0.06),   # Automatic
        "reload":   (0.15, 0.05, 0.05),   # Compact
        "hold":     (0.25, 0.06, 0.07),   # Held at hip
        "silencer": (0.35, 0.04, 0.04),   # Long thin barrel
    }

    dims = weapon_shapes.get(pose_name)
    if not dims:
        return

    # Shared gunmetal material for all weapon props
    mat = bpy.data.materials.new(name=f"WeaponMat_{pose_name}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (0.15, 0.15, 0.17, 1.0)
        bsdf.inputs['Roughness'].default_value = 0.4
        bsdf.inputs['Metallic'].default_value = 0.9

    # Main weapon body
    bpy.ops.mesh.primitive_cube_add(size=1)
    weapon = bpy.context.object
    weapon.name = f"WeaponProp_{pose_name}"
    weapon.scale = dims
    weapon.data.materials.append(mat)
    weapon.parent = armature
    weapon.parent_type = 'BONE'
    weapon.parent_bone = "hand.R"
    weapon.location = (dims[0] * 0.5, 0, 0)

    # Silencer gets a suppressor tip — wider cylinder at the barrel end
    if pose_name == "silencer":
        bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1)
        suppressor = bpy.context.object
        suppressor.name = "WeaponProp_silencer_tip"
        suppressor.scale = (0.07, 0.07, 0.15)
        suppressor.rotation_euler = (0, math.radians(90), 0)
        suppressor.data.materials.append(mat)
        suppressor.parent = armature
        suppressor.parent_type = 'BONE'
        suppressor.parent_bone = "hand.R"
        suppressor.location = (dims[0] + 0.05, 0, 0)  # At barrel tip

    bpy.context.view_layer.update()
    print(f"    Attached weapon prop: {pose_name} ({dims[0]:.2f}×{dims[1]:.2f}m)")


def render_frame(output_path: Path):
    """Render a single frame to the given path."""
    bpy.context.scene.render.filepath = str(output_path)
    bpy.ops.render.render(write_still=True)


def render_character(char: dict, model_path: Path, template_path=None, force=False, weapon_model=None):
    """Render all poses for a character across all directions using template.

    If the model has an armature (rigged), bone rotations from POSE_PRESETS
    are applied for each pose. Otherwise, all poses render the same static mesh.
    """
    char_id = char["id"]
    poses = char.get("poses", ["stand"])
    directions = char.get("directions", list(DIRECTIONS.keys()))

    print(f"\n  Rendering character: {char_id}")
    print(f"  Directions: {len(directions)}, Poses: {len(poses)}")

    # Load template
    if template_path:
        tpath = Path(template_path)
    else:
        tpath = get_template_path("characters")
    scene = load_blender_template(tpath)

    # Link model to template first (need to detect material type for engine choice)
    pivot, armature = link_model_to_template(model_path)
    if not pivot:
        return

    # Detect if model has PBR textures (needs Cycles) or simple materials (EEVEE ok)
    import bpy as _bpy
    mesh_objs = [o for o in _bpy.data.objects if o.type == 'MESH']
    has_textures = any(
        mat and mat.use_nodes and any(n.type == 'TEX_IMAGE' and n.image for n in mat.node_tree.nodes)
        for obj in mesh_objs for mat in (obj.data.materials or []) if mat
    )
    has_any_materials = any(mat for obj in mesh_objs for mat in (obj.data.materials or []) if mat)
    accent = char.get('color', None) if isinstance(char, dict) else getattr(char, 'color', None)

    configure_alpha_rendering(scene)
    configure_camera_framing(scene, target_z=0.6, ortho_scale=2.5)

    # Material handling: replace textures with accent color if present (EEVEE can't
    # render embedded textures in background mode). Keep vertex colors and simple materials.
    if has_textures and accent:
        setup_asset_material(mesh_objs, accent_color=accent)
        print(f"  Replaced textures with accent color {accent}")
    elif has_any_materials:
        print(f"  Keeping existing materials ({sum(len(o.data.materials) for o in mesh_objs)} slots)")
    elif accent:
        setup_asset_material(mesh_objs, accent_color=accent)
        print(f"  Applied accent color: {accent} (no existing materials)")

    # Parent lights to pivot so lighting is uniform across all 8 directions
    parent_lights_to_pivot(pivot)

    if armature:
        print(f"  Posing enabled: {len(armature.pose.bones)} bones")
    else:
        print(f"  Static model (no armature) — all poses will look identical")

    # Find inner pivot for walk lean (outer pivot controls direction rotation)
    inner_pivot = None
    for obj in bpy.data.objects:
        if obj.name == "ModelInnerPivot":
            inner_pivot = obj
            break

    for pose_name in poses:
        # Apply pose bones if rigged
        if armature:
            apply_pose(armature, pose_name)
            # Attach weapon geometry so weapons are visible at 64px
            attach_weapon_prop(armature, pose_name, weapon_model_path=weapon_model)

        # Walk pose: apply forward lean + slight bob on inner pivot
        # This works even when auto-rigging fails to deform the mesh
        if pose_name == "walk" and inner_pivot:
            inner_pivot.rotation_euler.x += math.radians(-8)   # Forward lean
            inner_pivot.location.z += 0.04                      # Slight vertical bob
            bpy.context.view_layer.update()

        for direction in directions:
            angle = DIRECTIONS.get(direction, 0)

            # Rotate model to face direction
            pivot.rotation_euler = (0, 0, math.radians(angle))
            pivot.location = (0, 0, 0)
            bpy.context.view_layer.update()

            out_dir = ensure_output_dir("characters", char_id)
            filename = f"{char_id}-{pose_name}-{direction}.png"
            out_path = out_dir / filename

            if force or not out_path.exists():
                render_frame(out_path)
                print(f"    {filename}")

        # Reset walk lean on inner pivot
        if pose_name == "walk" and inner_pivot:
            inner_pivot.rotation_euler.x -= math.radians(-8)
            inner_pivot.location.z -= 0.04
            bpy.context.view_layer.update()

        # Remove weapon prop before next pose (avoid stacking)
        for obj in list(bpy.data.objects):
            if obj.name.startswith("WeaponProp_"):
                bpy.data.objects.remove(obj, do_unlink=True)

    clear_model()


def render_static(asset: dict, category: str, model_path: Path, template_path=None, force=False):
    """Render a static or simple-animation asset using appropriate template."""
    asset_id = asset["id"]
    num_frames = asset.get("frames", 1)

    print(f"\n  Rendering {category}: {asset_id} ({num_frames} frames)")

    # Load template for this category
    if template_path:
        tpath = Path(template_path)
    else:
        tpath = get_template_path(category)
    scene = load_blender_template(tpath)

    # Link model first (need to detect material type for engine choice)
    pivot, _armature = link_model_to_template(model_path)
    if not pivot:
        return

    # Detect PBR textures — if present, replace with accent color since
    # EEVEE in WSL Blender can't render embedded textures in background mode
    has_textures = any(
        mat and mat.use_nodes and any(n.type == 'TEX_IMAGE' and n.image for n in mat.node_tree.nodes)
        for obj in bpy.data.objects if obj.type == 'MESH'
        for mat in (obj.data.materials or []) if mat
    )
    if has_textures:
        accent = asset.get('color', '#888888')
        mesh_objs = [o for o in bpy.data.objects if o.type == 'MESH']
        setup_asset_material(mesh_objs, accent_color=accent)
        print(f"  Replaced textures with accent color {accent} (EEVEE can't render textures in background)")

    configure_alpha_rendering(scene)
    configure_camera_framing(scene, target_z=0.5, ortho_scale=2.0)

    # Parent lights to pivot for uniform lighting
    parent_lights_to_pivot(pivot)

    for frame_idx in range(num_frames):
        out_dir = ensure_output_dir(category, asset_id)
        filename = f"{asset_id}-{frame_idx:02d}.png"
        out_path = out_dir / filename

        if not force and out_path.exists():
            continue

        # Subtle idle animation (rotation or pulse)
        if num_frames > 1:
            angle = (frame_idx / num_frames) * math.pi * 2
            pivot.rotation_euler.z = math.radians(15) * math.sin(angle)
            scale_pulse = 1.0 + 0.03 * math.sin(angle)
            pivot.scale = (scale_pulse, scale_pulse, scale_pulse)

        render_frame(out_path)
        print(f"    {filename}")

    clear_model()


def main():
    if not IN_BLENDER:
        print("This script must be run inside Blender:")
        print("  blender --background --python render_sprites.py -- [options]")
        sys.exit(1)

    # Parse args after "--"
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--category", help="Only render this category")
    parser.add_argument("--id", help="Only render this asset ID")
    parser.add_argument("--model", help="Model .glb path (overrides default)")
    parser.add_argument("--template", help="Template .blend path (overrides default)")
    parser.add_argument("--output", help="Output directory (overrides default)")
    parser.add_argument("--poses", help="Comma-separated pose list (default: stand)")
    parser.add_argument("--force", action="store_true", help="Re-render even if files exist")
    parser.add_argument("--accent-color", dest="accent_color", default=None,
                        help="Accent hex color for consistent material (e.g. #00f2ff)")
    parser.add_argument("--weapon-model", dest="weapon_model", default=None,
                        help="GLB path for weapon prop (replaces procedural geometry)")
    args = parser.parse_args(argv)

    global OUTPUT_BASE
    if args.output:
        OUTPUT_BASE = Path(args.output)

    pose_list = args.poses.split(",") if args.poses else None
    frame_count = 0

    # Direct mode: --model, --id, and --category are all provided
    # Process a single model without needing a manifest entry
    if args.model and args.id and args.category:
        model_path = Path(args.model)
        if not model_path.exists():
            print(f"  [ERROR] Model not found: {model_path}")
            sys.exit(1)

        default_poses = pose_list or ["stand", "walk", "gun", "machine", "reload", "hold", "silencer"]
        asset_stub = {"id": args.id, "poses": default_poses, "directions": list(DIRECTIONS.keys()),
                      "color": args.accent_color}

        if args.category == "characters":
            render_character(asset_stub, model_path, template_path=args.template, force=args.force, weapon_model=args.weapon_model)
            out_dir = OUTPUT_BASE / "characters" / args.id
        else:
            render_static(asset_stub, args.category, model_path, template_path=args.template, force=args.force)
            out_dir = OUTPUT_BASE / args.category / args.id

        # Count rendered frames
        if out_dir.exists():
            frame_count = len([f for f in out_dir.iterdir() if f.suffix == '.png'])

        print(f"FRAMES:{frame_count}")
        print(f"\n[DONE] Renders saved to {OUTPUT_BASE}")
        if frame_count == 0:
            sys.exit(1)
        sys.exit(0)

    # Manifest mode: iterate over manifest entries
    manifest = load_manifest()

    # Render characters
    if not args.category or args.category == "characters":
        for char in manifest.get("characters", []):
            if args.id and char["id"] != args.id:
                continue
            if pose_list:
                char = {**char, "poses": pose_list}
            if args.model:
                model_path = Path(args.model)
            else:
                model_path = MODELS_DIR / "characters" / f"{char['id']}.glb"
            if model_path.exists():
                render_character(char, model_path, template_path=args.template, force=args.force, weapon_model=args.weapon_model)
            else:
                print(f"  [SKIP] No model for character {char['id']}")

    # Render items, weapons, cover
    for cat in ["items", "weapons", "cover"]:
        if args.category and args.category != cat:
            continue
        for asset in manifest.get(cat, []):
            if args.id and asset["id"] != args.id:
                continue
            if args.model:
                model_path = Path(args.model)
            else:
                model_path = MODELS_DIR / cat / f"{asset['id']}.glb"
            if model_path.exists():
                render_static(asset, cat, model_path, template_path=args.template, force=args.force)
            else:
                print(f"  [SKIP] No model for {cat}/{asset['id']}")

    print(f"\n[DONE] Renders saved to {OUTPUT_BASE}")


if __name__ == "__main__":
    main()
