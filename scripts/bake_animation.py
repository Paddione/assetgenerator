"""
bake_animation.py — Bake simple procedural animations onto a rigged GLB.

Generates walk and idle animation clips using bone keyframes, then exports
the result as a GLB with embedded animation clips.

Usage:
    blender --background --python bake_animation.py -- \
        --input model_rigged.glb --output model_animated.glb
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
    parser = argparse.ArgumentParser(description='Bake animations onto a rigged GLB')
    parser.add_argument('--input', required=True, help='Input rigged GLB file')
    parser.add_argument('--output', required=True, help='Output animated GLB file')
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)
    for block in bpy.data.armatures:
        bpy.data.armatures.remove(block)
    for block in bpy.data.actions:
        bpy.data.actions.remove(block)


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    armature = None
    meshes = []
    for obj in bpy.context.selected_objects:
        if obj.type == 'ARMATURE':
            armature = obj
        elif obj.type == 'MESH':
            meshes.append(obj)
    return armature, meshes


def find_bone(armature, *names):
    """Find first matching bone by name (case-insensitive partial match)."""
    for name in names:
        for bone in armature.pose.bones:
            if name.lower() in bone.name.lower():
                return bone
    return None


def set_bone_rotation(bone, axis, angle, frame):
    """Set a bone's rotation at a keyframe. Uses quaternion rotation."""
    if axis == 'X':
        q = mathutils.Quaternion((1, 0, 0), angle)
    elif axis == 'Y':
        q = mathutils.Quaternion((0, 1, 0), angle)
    elif axis == 'Z':
        q = mathutils.Quaternion((0, 0, 1), angle)
    else:
        q = mathutils.Quaternion()
    bone.rotation_quaternion = q
    bone.keyframe_insert(data_path='rotation_quaternion', frame=frame)


def set_bone_location(bone, loc, frame):
    """Set a bone's location at a keyframe."""
    bone.location = loc
    bone.keyframe_insert(data_path='location', frame=frame)


def create_walk_action(armature):
    """Create a walk cycle animation using leg and arm bone rotations."""
    action = bpy.data.actions.new(name='walk')
    armature.animation_data_create()
    armature.animation_data.action = action

    fps = 24
    cycle_frames = 24  # 1 second cycle

    # Find key bones
    upper_leg_l = find_bone(armature, 'upper_leg.L', 'thigh.L', 'upperleg.l')
    upper_leg_r = find_bone(armature, 'upper_leg.R', 'thigh.R', 'upperleg.r')
    lower_leg_l = find_bone(armature, 'shin.L', 'lower_leg.L', 'lowerleg.l')
    lower_leg_r = find_bone(armature, 'shin.R', 'lower_leg.R', 'lowerleg.r')
    upper_arm_l = find_bone(armature, 'upper_arm.L', 'arm.L', 'upperarm.l')
    upper_arm_r = find_bone(armature, 'upper_arm.R', 'arm.R', 'upperarm.r')
    spine = find_bone(armature, 'spine', 'torso')

    swing = 0.4  # leg swing amplitude in radians
    arm_swing = 0.25
    knee_bend = 0.3
    steps = 5  # keyframe density

    for i in range(steps + 1):
        frame = int(i * cycle_frames / steps) + 1
        t = i / steps  # 0..1
        phase = t * math.pi * 2

        # Legs swing opposite
        if upper_leg_l:
            set_bone_rotation(upper_leg_l, 'X', math.sin(phase) * swing, frame)
        if upper_leg_r:
            set_bone_rotation(upper_leg_r, 'X', -math.sin(phase) * swing, frame)

        # Knees bend at contact (abs of swing)
        if lower_leg_l:
            set_bone_rotation(lower_leg_l, 'X', abs(math.sin(phase)) * knee_bend, frame)
        if lower_leg_r:
            set_bone_rotation(lower_leg_r, 'X', abs(math.sin(phase + math.pi)) * knee_bend, frame)

        # Arms swing opposite to legs
        if upper_arm_l:
            set_bone_rotation(upper_arm_l, 'X', -math.sin(phase) * arm_swing, frame)
        if upper_arm_r:
            set_bone_rotation(upper_arm_r, 'X', math.sin(phase) * arm_swing, frame)

        # Subtle spine twist
        if spine:
            set_bone_rotation(spine, 'Z', math.sin(phase) * 0.05, frame)

    # Make cyclic
    if action.fcurves:
        for fc in action.fcurves:
            mod = fc.modifiers.new(type='CYCLES')
            mod.mode_before = 'REPEAT'
            mod.mode_after = 'REPEAT'

    action.frame_range = (1, cycle_frames + 1)
    print(f'[bake_animation] Created walk action: {cycle_frames} frames, '
          f'bones found: legs={bool(upper_leg_l)}/{bool(upper_leg_r)} '
          f'arms={bool(upper_arm_l)}/{bool(upper_arm_r)} spine={bool(spine)}')
    return action


def create_idle_action(armature):
    """Create a subtle idle breathing animation."""
    action = bpy.data.actions.new(name='idle')
    armature.animation_data.action = action

    cycle_frames = 48  # 2 seconds at 24fps
    spine = find_bone(armature, 'spine', 'torso')
    chest = find_bone(armature, 'spine.001', 'chest')
    head = find_bone(armature, 'head')

    steps = 5
    for i in range(steps + 1):
        frame = int(i * cycle_frames / steps) + 1
        t = i / steps
        phase = t * math.pi * 2

        # Gentle breathing: spine bobs up slightly
        if spine:
            set_bone_rotation(spine, 'X', math.sin(phase) * 0.02, frame)
        if chest:
            set_bone_rotation(chest, 'X', math.sin(phase) * 0.015, frame)
        if head:
            set_bone_rotation(head, 'Y', math.sin(phase * 0.5) * 0.01, frame)

    if action.fcurves:
        for fc in action.fcurves:
            mod = fc.modifiers.new(type='CYCLES')
            mod.mode_before = 'REPEAT'
            mod.mode_after = 'REPEAT'

    action.frame_range = (1, cycle_frames + 1)
    print(f'[bake_animation] Created idle action: {cycle_frames} frames')
    return action


def export_glb(path, armature, meshes):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    armature.select_set(True)
    for mesh in meshes:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = armature

    # Push all actions into NLA tracks so they export as separate clips
    if armature.animation_data:
        armature.animation_data.action = None
        for action in bpy.data.actions:
            track = armature.animation_data.nla_tracks.new()
            track.name = action.name
            strip = track.strips.new(action.name, int(action.frame_range[0]), action)
            strip.name = action.name

    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_skins=True,
        export_nla_strips=True,
        export_apply=False,
    )


def main():
    args = parse_args()
    input_path = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output)

    if not os.path.isfile(input_path):
        print(f'ERROR: Input not found: {input_path}', file=sys.stderr)
        sys.exit(1)

    print('[bake_animation] Clearing scene...')
    clear_scene()

    print(f'[bake_animation] Importing {input_path}...')
    armature, meshes = import_glb(input_path)
    if not armature:
        print('ERROR: No armature found in input GLB', file=sys.stderr)
        sys.exit(1)

    print(f'[bake_animation] Armature: {armature.name}, {len(armature.data.bones)} bones')

    # List bone names for debugging
    bone_names = [b.name for b in armature.data.bones]
    print(f'[bake_animation] Bones: {", ".join(bone_names[:20])}{"..." if len(bone_names) > 20 else ""}')

    print('[bake_animation] Creating walk animation...')
    walk_action = create_walk_action(armature)

    print('[bake_animation] Creating idle animation...')
    idle_action = create_idle_action(armature)

    print(f'[bake_animation] Exporting to {output_path}...')
    export_glb(output_path, armature, meshes)

    print(f'[bake_animation] Done. Output: {output_path}')


if __name__ == '__main__':
    main()
