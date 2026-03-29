"""
auto_rig.py — Blender Rigify humanoid auto-rigging script.

Imports a GLB mesh, adds a Rigify humanoid metarig scaled to match the mesh,
generates the final rig, parents the mesh with automatic weights, and exports
the result as a GLB.

Usage:
    blender --background --python auto_rig.py -- --input model.glb --output model_rigged.glb
"""

import sys
import os
import argparse

import bpy
import mathutils


def parse_args():
    # Arguments after '--' are passed to the script
    argv = sys.argv
    if '--' in argv:
        argv = argv[argv.index('--') + 1:]
    else:
        argv = []

    parser = argparse.ArgumentParser(description='Auto-rig a GLB mesh using Rigify')
    parser.add_argument('--input', required=True, help='Input GLB file path')
    parser.add_argument('--output', required=True, help='Output GLB file path')
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    # Remove orphaned data
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)
    for block in bpy.data.armatures:
        bpy.data.armatures.remove(block)


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    # Return all imported mesh objects
    return [obj for obj in bpy.context.selected_objects if obj.type == 'MESH']


def get_mesh_bounds(mesh_objects):
    """Return (min_z, max_z, center_xy, height) across all mesh objects."""
    all_verts = []
    for obj in mesh_objects:
        mat = obj.matrix_world
        for v in obj.data.vertices:
            all_verts.append(mat @ v.co)

    if not all_verts:
        return 0.0, 2.0, mathutils.Vector((0, 0)), 2.0

    xs = [v.x for v in all_verts]
    ys = [v.y for v in all_verts]
    zs = [v.z for v in all_verts]

    min_z = min(zs)
    max_z = max(zs)
    height = max_z - min_z
    center_xy = mathutils.Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2))
    return min_z, max_z, center_xy, height


def add_humanoid_metarig(min_z, height, center_xy):
    """Add a Rigify human metarig and scale it to match the mesh height."""
    # Enable Rigify add-on if not already enabled
    if not bpy.context.preferences.addons.get('rigify'):
        bpy.ops.preferences.addon_enable(module='rigify')

    bpy.ops.object.armature_human_metarig_add()
    metarig = bpy.context.active_object
    assert metarig and metarig.type == 'ARMATURE', 'Failed to create metarig'

    # Rigify metarig default height is approximately 2.0m; scale to match mesh
    default_height = 2.0
    scale_factor = height / default_height

    metarig.scale = (scale_factor, scale_factor, scale_factor)
    metarig.location = mathutils.Vector((center_xy.x, center_xy.y, min_z))
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    return metarig


def generate_rig(metarig):
    """Run Rigify rig generation on the metarig."""
    bpy.context.view_layer.objects.active = metarig
    bpy.ops.pose.rigify_generate()

    # Find the generated rig (named 'rig' by default)
    rig = bpy.data.objects.get('rig')
    if rig is None:
        # Fallback: find armature that is not the metarig
        for obj in bpy.data.objects:
            if obj.type == 'ARMATURE' and obj != metarig:
                rig = obj
                break

    if rig is None:
        raise RuntimeError('Rigify rig generation failed: could not find generated rig')

    # Remove the metarig — only the final rig is needed
    bpy.data.objects.remove(metarig, do_unlink=True)
    return rig


def parent_with_auto_weights(mesh_objects, rig):
    """Parent all mesh objects to the rig using automatic weights."""
    # Deselect everything
    bpy.ops.object.select_all(action='DESELECT')

    for mesh in mesh_objects:
        mesh.select_set(True)

    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig

    bpy.ops.object.parent_set(type='ARMATURE_AUTO')


def clean_rig_for_export(rig):
    """Remove Rigify widget objects and non-deformation bones for glTF export.

    Rigify generates a control rig with IK/FK widgets, helper bones, and WGT-*
    mesh objects. The glTF exporter crashes on these. We strip everything except
    deformation bones (DEF-*) which are what actually drive mesh vertices.
    """
    # Remove all WGT-* widget mesh objects
    wgt_objects = [obj for obj in bpy.data.objects if obj.name.startswith('WGT-')]
    for obj in wgt_objects:
        bpy.data.objects.remove(obj, do_unlink=True)

    # Enter edit mode on the armature to remove non-deformation bones
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')

    # Rigify deformation bones are prefixed with "DEF-"
    # Keep only DEF-* bones and the root bone
    bones_to_remove = []
    for bone in rig.data.edit_bones:
        if not bone.name.startswith('DEF-') and bone.name != 'root':
            bones_to_remove.append(bone.name)

    for bone_name in bones_to_remove:
        bone = rig.data.edit_bones.get(bone_name)
        if bone:
            rig.data.edit_bones.remove(bone)

    bpy.ops.object.mode_set(mode='OBJECT')

    # Rename DEF- prefix to clean names for runtime
    bpy.ops.object.mode_set(mode='EDIT')
    for bone in rig.data.edit_bones:
        if bone.name.startswith('DEF-'):
            bone.name = bone.name[4:]  # Strip "DEF-" prefix
    bpy.ops.object.mode_set(mode='OBJECT')

    print(f'[auto_rig] Cleaned rig: {len(rig.data.bones)} deformation bones remain')


def export_glb(path, rig, mesh_objects):
    """Export only the rig and mesh objects as GLB."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    # Select only what we want to export
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    for mesh in mesh_objects:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = rig

    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_skins=True,
        export_apply=False,
    )


def main():
    args = parse_args()

    input_path = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output)

    if not os.path.isfile(input_path):
        print(f'ERROR: Input file not found: {input_path}', file=sys.stderr)
        sys.exit(1)

    print(f'[auto_rig] Clearing scene...')
    clear_scene()

    print(f'[auto_rig] Importing {input_path}...')
    mesh_objects = import_glb(input_path)
    if not mesh_objects:
        print('ERROR: No mesh objects found in input GLB', file=sys.stderr)
        sys.exit(1)
    print(f'[auto_rig] Found {len(mesh_objects)} mesh object(s)')

    min_z, max_z, center_xy, height = get_mesh_bounds(mesh_objects)
    print(f'[auto_rig] Mesh bounds: z={min_z:.3f}..{max_z:.3f}, height={height:.3f}m, center_xy={center_xy}')

    print(f'[auto_rig] Adding Rigify humanoid metarig...')
    metarig = add_humanoid_metarig(min_z, height, center_xy)

    print(f'[auto_rig] Generating rig...')
    rig = generate_rig(metarig)

    print(f'[auto_rig] Parenting mesh to rig with automatic weights...')
    parent_with_auto_weights(mesh_objects, rig)

    print(f'[auto_rig] Cleaning rig for glTF export...')
    clean_rig_for_export(rig)

    print(f'[auto_rig] Exporting to {output_path}...')
    export_glb(output_path, rig, mesh_objects)

    print(f'[auto_rig] Done. Output: {output_path}')


if __name__ == '__main__':
    main()
