"""
simple_rig.py — Add a basic humanoid skeleton to a GLB mesh.

Creates a simple deformation-only armature (no Rigify, no control rig)
with ~20 bones suitable for runtime animation. Parents the mesh with
automatic weights and exports as GLB.

Usage:
    blender --background --python simple_rig.py -- --input model.glb --output model_rigged.glb
"""

import sys
import os
import argparse
import math

import bpy
import mathutils


def parse_args():
    argv = sys.argv
    if '--' in argv:
        argv = argv[argv.index('--') + 1:]
    else:
        argv = []
    parser = argparse.ArgumentParser(description='Simple humanoid rig for GLB models')
    parser.add_argument('--input', required=True, help='Input GLB file path')
    parser.add_argument('--output', required=True, help='Output GLB file path')
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)
    for block in bpy.data.armatures:
        bpy.data.armatures.remove(block)


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    return [obj for obj in bpy.context.selected_objects if obj.type == 'MESH']


def get_mesh_bounds(mesh_objects):
    all_verts = []
    for obj in mesh_objects:
        mat = obj.matrix_world
        for v in obj.data.vertices:
            all_verts.append(mat @ v.co)

    if not all_verts:
        return 0.0, 2.0, mathutils.Vector((0, 0, 0)), 2.0

    xs = [v.x for v in all_verts]
    ys = [v.y for v in all_verts]
    zs = [v.z for v in all_verts]

    min_pt = mathutils.Vector((min(xs), min(ys), min(zs)))
    max_pt = mathutils.Vector((max(xs), max(ys), max(zs)))
    center = (min_pt + max_pt) / 2
    height = max_pt.z - min_pt.z

    return min_pt.z, max_pt.z, center, height


def create_simple_skeleton(min_z, height, center):
    """Create a simple ~20-bone humanoid skeleton scaled to the mesh.

    Bone layout (Y-up in Blender):
        hips → spine → chest → neck → head
        chest → shoulder.L → upper_arm.L → forearm.L → hand.L
        chest → shoulder.R → upper_arm.R → forearm.R → hand.R
        hips → upper_leg.L → lower_leg.L → foot.L → toe.L
        hips → upper_leg.R → lower_leg.R → foot.R → toe.R
    """
    arm_data = bpy.data.armatures.new('Armature')
    arm_obj = bpy.data.objects.new('Armature', arm_data)
    bpy.context.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    arm_obj.select_set(True)

    # Scale factors relative to mesh height
    h = height
    cx, cy = center.x, center.y
    base = min_z

    # Proportions (fraction of total height)
    foot_h = base
    ankle_h = base + h * 0.05
    knee_h = base + h * 0.28
    hip_h = base + h * 0.48
    spine_h = base + h * 0.58
    chest_h = base + h * 0.70
    shoulder_h = base + h * 0.78
    neck_h = base + h * 0.82
    head_h = base + h * 0.88
    head_top = base + h * 1.0

    # Arm proportions (horizontal spread)
    shoulder_w = h * 0.18
    elbow_w = h * 0.32
    wrist_w = h * 0.42
    hand_w = h * 0.46

    bpy.ops.object.mode_set(mode='EDIT')

    def add_bone(name, head, tail, parent_name=None):
        bone = arm_data.edit_bones.new(name)
        bone.head = mathutils.Vector(head)
        bone.tail = mathutils.Vector(tail)
        bone.use_deform = True
        if parent_name:
            parent = arm_data.edit_bones.get(parent_name)
            if parent:
                bone.parent = parent
                bone.use_connect = (bone.head - parent.tail).length < 0.001
        return bone

    # Spine chain
    add_bone('hips', (cx, cy, hip_h), (cx, cy, spine_h))
    add_bone('spine', (cx, cy, spine_h), (cx, cy, chest_h), 'hips')
    add_bone('chest', (cx, cy, chest_h), (cx, cy, shoulder_h), 'spine')
    add_bone('neck', (cx, cy, neck_h), (cx, cy, head_h), 'chest')
    add_bone('head', (cx, cy, head_h), (cx, cy, head_top), 'neck')

    # Left arm
    add_bone('shoulder.L', (cx, cy, shoulder_h), (cx + shoulder_w, cy, shoulder_h), 'chest')
    add_bone('upper_arm.L', (cx + shoulder_w, cy, shoulder_h), (cx + elbow_w, cy, shoulder_h - h * 0.05), 'shoulder.L')
    add_bone('forearm.L', (cx + elbow_w, cy, shoulder_h - h * 0.05), (cx + wrist_w, cy, shoulder_h - h * 0.02), 'upper_arm.L')
    add_bone('hand.L', (cx + wrist_w, cy, shoulder_h - h * 0.02), (cx + hand_w, cy, shoulder_h - h * 0.02), 'forearm.L')

    # Right arm
    add_bone('shoulder.R', (cx, cy, shoulder_h), (cx - shoulder_w, cy, shoulder_h), 'chest')
    add_bone('upper_arm.R', (cx - shoulder_w, cy, shoulder_h), (cx - elbow_w, cy, shoulder_h - h * 0.05), 'shoulder.R')
    add_bone('forearm.R', (cx - elbow_w, cy, shoulder_h - h * 0.05), (cx - wrist_w, cy, shoulder_h - h * 0.02), 'upper_arm.R')
    add_bone('hand.R', (cx - wrist_w, cy, shoulder_h - h * 0.02), (cx - hand_w, cy, shoulder_h - h * 0.02), 'forearm.R')

    # Left leg
    leg_spread = h * 0.08
    add_bone('upper_leg.L', (cx + leg_spread, cy, hip_h), (cx + leg_spread, cy, knee_h), 'hips')
    add_bone('lower_leg.L', (cx + leg_spread, cy, knee_h), (cx + leg_spread, cy, ankle_h), 'upper_leg.L')
    add_bone('foot.L', (cx + leg_spread, cy, ankle_h), (cx + leg_spread, cy - h * 0.08, foot_h), 'lower_leg.L')
    add_bone('toe.L', (cx + leg_spread, cy - h * 0.08, foot_h), (cx + leg_spread, cy - h * 0.12, foot_h), 'foot.L')

    # Right leg
    add_bone('upper_leg.R', (cx - leg_spread, cy, hip_h), (cx - leg_spread, cy, knee_h), 'hips')
    add_bone('lower_leg.R', (cx - leg_spread, cy, knee_h), (cx - leg_spread, cy, ankle_h), 'upper_leg.R')
    add_bone('foot.R', (cx - leg_spread, cy, ankle_h), (cx - leg_spread, cy - h * 0.08, foot_h), 'lower_leg.R')
    add_bone('toe.R', (cx - leg_spread, cy - h * 0.08, foot_h), (cx - leg_spread, cy - h * 0.12, foot_h), 'foot.R')

    bpy.ops.object.mode_set(mode='OBJECT')
    print(f'[simple_rig] Created skeleton with {len(arm_data.bones)} bones, height={height:.3f}m')
    return arm_obj


def parent_with_auto_weights(mesh_objects, armature):
    """Parent meshes to armature with automatic weights, falling back to envelope."""
    bpy.ops.object.select_all(action='DESELECT')
    for mesh in mesh_objects:
        mesh.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature

    # Try automatic weights first (best quality)
    try:
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    except RuntimeError:
        print('[simple_rig] Auto weights failed, falling back to envelope weights')
        bpy.ops.object.parent_set(type='ARMATURE_ENVELOPE')

    # Ensure every bone has at least some weight on every mesh.
    # Blender 4.0.2 glTF exporter crashes (skin.joints is None) if a mesh
    # has an armature modifier but some bones have zero vertex group entries.
    for mesh_obj in mesh_objects:
        for bone in armature.data.bones:
            if bone.name not in mesh_obj.vertex_groups:
                # Create an empty vertex group so the skin binding is valid
                mesh_obj.vertex_groups.new(name=bone.name)

    # Remove the armature modifier from any mesh that ended up with all-zero weights
    # and re-add it to force a clean skin binding
    for mesh_obj in mesh_objects:
        # Check if mesh actually has any non-zero weights
        has_weights = False
        for vg in mesh_obj.vertex_groups:
            for v in mesh_obj.data.vertices:
                try:
                    w = vg.weight(v.index)
                    if w > 0:
                        has_weights = True
                        break
                except RuntimeError:
                    pass  # Vertex not in this group — expected
            if has_weights:
                break

        if not has_weights:
            print(f'[simple_rig] WARNING: {mesh_obj.name} has no weights, assigning to nearest bone')
            # Assign all vertices to the hips bone as fallback
            hips_vg = mesh_obj.vertex_groups.get('hips')
            if hips_vg:
                all_verts = [v.index for v in mesh_obj.data.vertices]
                hips_vg.add(all_verts, 1.0, 'REPLACE')


def export_glb(path, armature, mesh_objects):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    bpy.ops.object.select_all(action='DESELECT')
    armature.select_set(True)
    for mesh in mesh_objects:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = armature

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

    print(f'[simple_rig] Clearing scene...')
    clear_scene()

    print(f'[simple_rig] Importing {input_path}...')
    mesh_objects = import_glb(input_path)
    if not mesh_objects:
        print('ERROR: No mesh objects found in input GLB', file=sys.stderr)
        sys.exit(1)
    print(f'[simple_rig] Found {len(mesh_objects)} mesh object(s)')

    min_z, max_z, center, height = get_mesh_bounds(mesh_objects)
    print(f'[simple_rig] Mesh bounds: z={min_z:.3f}..{max_z:.3f}, height={height:.3f}m')

    print(f'[simple_rig] Creating simple humanoid skeleton...')
    armature = create_simple_skeleton(min_z, height, center)

    print(f'[simple_rig] Parenting mesh with automatic weights...')
    parent_with_auto_weights(mesh_objects, armature)

    print(f'[simple_rig] Exporting to {output_path}...')
    export_glb(output_path, armature, mesh_objects)

    file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
    print(f'[simple_rig] Done. Output: {output_path} ({file_size / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
