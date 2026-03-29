#!/usr/bin/env python3
"""
Post-render validation for sprite frames.

Checks rendered PNG frames for common quality issues:
1. Alpha fringing (non-clean edges)
2. Direction consistency (silhouette area variance across 8 directions)
3. Pose distinctiveness (silhouette difference between weapon poses)
4. Blank/corrupt frames (empty or nearly-empty alpha channels)

Usage:
    python validate_renders.py --dir renders/characters/student
    python validate_renders.py --dir renders/characters/student --threshold 7.0
"""

import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image
    import numpy as np
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def check_alpha_fringing(img_array, threshold=10):
    """Detect semi-transparent edge pixels that indicate alpha bleed.

    Counts pixels with alpha between 10-240 (neither fully opaque nor transparent).
    A clean render should have very few of these — they appear as fringes/halos.
    """
    alpha = img_array[:, :, 3]
    fringe_pixels = np.sum((alpha > threshold) & (alpha < 255 - threshold))
    total_visible = np.sum(alpha > threshold)
    if total_visible == 0:
        return 0.0
    fringe_ratio = fringe_pixels / total_visible
    return fringe_ratio


def silhouette_area(img_array, threshold=10):
    """Count non-transparent pixels (the character's silhouette area)."""
    alpha = img_array[:, :, 3]
    return int(np.sum(alpha > threshold))


def silhouette_hash(img_array, threshold=10):
    """Binary silhouette as a flattened array for comparison."""
    alpha = img_array[:, :, 3]
    return (alpha > threshold).astype(np.uint8)


def direction_consistency(frames_by_direction):
    """Check silhouette area variance across 8 directions for a single pose.

    Large variance means some angles render much smaller/larger than others
    (the N/NE problem). Returns coefficient of variation (stdev/mean).
    """
    areas = []
    for direction, img_array in frames_by_direction.items():
        areas.append(silhouette_area(img_array))

    if not areas or np.mean(areas) == 0:
        return 1.0  # Worst score if no visible pixels

    cv = np.std(areas) / np.mean(areas)
    return cv


def pose_distinctiveness(pose_silhouettes):
    """Measure how different each pose's silhouette is from the others.

    Compares binary silhouette overlap between all pose pairs.
    Returns the minimum difference ratio (worst pair). Values < 0.05 mean
    two poses are nearly indistinguishable.
    """
    pose_names = list(pose_silhouettes.keys())
    if len(pose_names) < 2:
        return 1.0

    min_diff = 1.0
    worst_pair = ("", "")

    for i, p1 in enumerate(pose_names):
        for p2 in pose_names[i + 1:]:
            s1 = pose_silhouettes[p1]
            s2 = pose_silhouettes[p2]
            diff_pixels = np.sum(s1 != s2)
            total_pixels = max(np.sum(s1), np.sum(s2), 1)
            diff_ratio = diff_pixels / total_pixels
            if diff_ratio < min_diff:
                min_diff = diff_ratio
                worst_pair = (p1, p2)

    return min_diff, worst_pair


def validate_character(render_dir, char_id):
    """Run all validation checks on a character's rendered frames."""
    render_path = Path(render_dir)
    results = {
        "id": char_id,
        "frames_found": 0,
        "checks": {},
        "issues": [],
        "score": 0.0,
    }

    directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    poses = ["stand", "walk", "gun", "machine", "reload", "hold", "silencer"]

    # Load all frames
    frames = {}  # {pose: {direction: numpy_array}}
    for pose in poses:
        frames[pose] = {}
        for d in directions:
            path = render_path / f"{char_id}-{pose}-{d}.png"
            if path.exists():
                img = Image.open(path).convert("RGBA")
                frames[pose][d] = np.array(img)
                results["frames_found"] += 1

    if results["frames_found"] == 0:
        results["issues"].append("CRITICAL: No frames found")
        return results

    # Check 1: Blank/corrupt frames
    blank_frames = []
    for pose, dirs in frames.items():
        for d, arr in dirs.items():
            if silhouette_area(arr) < 50:  # Less than 50 visible pixels
                blank_frames.append(f"{pose}-{d}")
    if blank_frames:
        results["checks"]["blank_frames"] = blank_frames
        results["issues"].append(f"CRITICAL: {len(blank_frames)} blank/corrupt frames")

    # Check 2: Alpha fringing per frame
    fringe_scores = {}
    for pose, dirs in frames.items():
        for d, arr in dirs.items():
            ratio = check_alpha_fringing(arr)
            if ratio > 0.15:  # More than 15% fringe pixels is bad
                fringe_scores[f"{pose}-{d}"] = round(ratio, 3)
    if fringe_scores:
        results["checks"]["alpha_fringing"] = fringe_scores
        results["issues"].append(f"WARNING: {len(fringe_scores)} frames with alpha fringing")

    # Check 3: Direction consistency per pose
    dir_scores = {}
    for pose, dirs in frames.items():
        if len(dirs) >= 4:  # Need at least half the directions
            cv = direction_consistency(dirs)
            dir_scores[pose] = round(cv, 3)
            if cv > 0.15:  # More than 15% coefficient of variation
                results["issues"].append(
                    f"WARNING: {pose} has {cv:.1%} silhouette variance across directions"
                )
    results["checks"]["direction_consistency"] = dir_scores

    # Check 4: Pose distinctiveness (average across all available directions)
    # Using only one direction (e.g. S) gives false negatives when a weapon
    # points toward/away from camera and gets foreshortened.
    pose_avg_sils = {}
    for pose, dirs in frames.items():
        sils = [silhouette_hash(arr) for arr in dirs.values()]
        if sils:
            # Average silhouette across directions (>0.5 = more often visible than not)
            pose_avg_sils[pose] = (np.mean(sils, axis=0) > 0.5).astype(np.uint8)
    if len(pose_avg_sils) >= 2:
        min_diff, worst_pair = pose_distinctiveness(pose_avg_sils)
        results["checks"]["pose_distinctiveness"] = {
            "min_difference": round(min_diff, 3),
            "worst_pair": list(worst_pair),
        }
        if min_diff < 0.02:
            results["issues"].append(
                f"CRITICAL: {worst_pair[0]} and {worst_pair[1]} are nearly identical "
                f"({min_diff:.1%} avg silhouette difference across all directions)"
            )
        elif min_diff < 0.05:
            results["issues"].append(
                f"WARNING: {worst_pair[0]} and {worst_pair[1]} are hard to distinguish "
                f"({min_diff:.1%} avg difference)"
            )

    # Compute overall score (0-10)
    score = 10.0
    score -= len(blank_frames) * 2.0
    score -= len(fringe_scores) * 0.2
    for cv in dir_scores.values():
        if cv > 0.15:
            score -= 0.5
    if len(pose_avg_sils) >= 2:
        min_diff_val = min_diff
        if min_diff_val < 0.02:
            score -= 2.0
        elif min_diff_val < 0.05:
            score -= 1.0
    results["score"] = round(max(0.0, score), 1)

    return results


def main():
    parser = argparse.ArgumentParser(description="Validate rendered sprite frames")
    parser.add_argument("--dir", required=True, help="Directory containing rendered PNGs")
    parser.add_argument("--id", help="Character ID (inferred from dir name if omitted)")
    parser.add_argument("--threshold", type=float, default=7.0,
                        help="Minimum passing score (default: 7.0)")
    parser.add_argument("--json", action="store_true", help="Output JSON instead of text")
    args = parser.parse_args()

    if not HAS_PIL:
        print("ERROR: Pillow and numpy required. Install with: pip install Pillow numpy")
        sys.exit(1)

    render_dir = Path(args.dir)
    if not render_dir.exists():
        print(f"ERROR: Directory not found: {render_dir}")
        sys.exit(1)

    char_id = args.id or render_dir.name

    results = validate_character(render_dir, char_id)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print(f"\n{'='*50}")
        print(f"Validation Report: {char_id}")
        print(f"{'='*50}")
        print(f"Frames found: {results['frames_found']}")
        print(f"Overall score: {results['score']}/10.0")
        print(f"Pass threshold: {args.threshold}/10.0")
        print(f"Result: {'PASS' if results['score'] >= args.threshold else 'FAIL'}")

        if results["issues"]:
            print(f"\nIssues ({len(results['issues'])}):")
            for issue in results["issues"]:
                print(f"  - {issue}")

        if "direction_consistency" in results["checks"]:
            print(f"\nDirection consistency (CV — lower is better):")
            for pose, cv in results["checks"]["direction_consistency"].items():
                status = "OK" if cv <= 0.15 else "WARN"
                print(f"  {pose:12s}: {cv:.3f} [{status}]")

        if "pose_distinctiveness" in results["checks"]:
            pd = results["checks"]["pose_distinctiveness"]
            print(f"\nPose distinctiveness:")
            print(f"  Minimum difference: {pd['min_difference']:.1%}")
            print(f"  Worst pair: {pd['worst_pair'][0]} vs {pd['worst_pair'][1]}")

        print()

    sys.exit(0 if results["score"] >= args.threshold else 1)


if __name__ == "__main__":
    main()
