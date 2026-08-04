#!/usr/bin/env python3
"""Read the render transform stored in CounterSide unit Unity bundles."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import UnityPy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.cs_asset_decrypt import decrypt_bundle_header


def pointer_id(value):
    if not isinstance(value, dict):
        return 0
    value = value.get("component", value)
    return int(value.get("m_PathID", 0))


def multiply(left, right):
    a, b, c, d, tx, ty = left
    e, f, g, h, ux, uy = right
    return (
        a * e + c * f,
        b * e + d * f,
        a * g + c * h,
        b * g + d * h,
        a * ux + c * uy + tx,
        b * ux + d * uy + ty,
    )


def local_matrix(transform):
    position = transform.get("m_LocalPosition", {})
    scale = transform.get("m_LocalScale", {})
    rotation = transform.get("m_LocalRotation", {})
    x, y = float(rotation.get("z", 0)), float(rotation.get("w", 1))
    angle = 2 * math.atan2(x, y)
    sine, cosine = math.sin(angle), math.cos(angle)
    sx, sy = float(scale.get("x", 1)), float(scale.get("y", 1))
    return (
        cosine * sx,
        sine * sx,
        -sine * sy,
        cosine * sy,
        float(position.get("x", 0)),
        float(position.get("y", 0)),
    )


def read_bundle(path):
    environment = UnityPy.load(decrypt_bundle_header(path))
    trees, types = {}, {}
    for obj in environment.objects:
        types[obj.path_id] = obj.type.name
        try:
            trees[obj.path_id] = obj.read_typetree()
        except Exception:
            pass

    animations = []
    for path_id, tree in trees.items():
        data_id = pointer_id(tree.get("skeletonDataAsset"))
        game_object_id = pointer_id(tree.get("m_GameObject"))
        if types.get(path_id) != "MonoBehaviour" or not data_id or not game_object_id:
            continue
        game_object = trees.get(game_object_id, {})
        if data_id not in trees or not game_object:
            continue
        transform_id = next(
            (pointer_id(item) for item in game_object.get("m_Component", []) if types.get(pointer_id(item)) == "Transform"),
            0,
        )
        depth, parent_id = 0, transform_id
        while parent_id:
            depth += 1
            parent_id = pointer_id(trees[parent_id].get("m_Father"))
        animations.append((game_object.get("m_Name") != "SPINE_SkeletonAnimation", depth, path_id, tree, game_object))
    if not animations:
        raise ValueError("unit SkeletonAnimation was not found")

    _, _, _, animation, game_object = min(animations)
    data = trees.get(pointer_id(animation["skeletonDataAsset"]), {})
    transform_id = next(
        (pointer_id(item) for item in game_object.get("m_Component", []) if types.get(pointer_id(item)) == "Transform"),
        0,
    )
    if not transform_id:
        raise ValueError("unit SkeletonAnimation transform was not found")

    chain = []
    while transform_id:
        transform = trees[transform_id]
        chain.append(transform)
        transform_id = pointer_id(transform.get("m_Father"))
    chain.pop()  # NKCUnitClient owns and overwrites the prefab root transform.

    matrix = (1, 0, 0, 1, 0, 0)
    for transform in reversed(chain):
        matrix = multiply(matrix, local_matrix(transform))
    a, b, c, d, tx, ty = matrix
    return {
        "skeletonDataScale": float(data.get("scale", 1)),
        "hierarchyScaleX": math.hypot(a, b),
        "hierarchyScaleY": math.copysign(math.hypot(c, d), a * d - b * c),
        "hierarchyOffsetX": tx,
        "hierarchyOffsetY": ty,
        "hierarchyRotation": math.atan2(b, a),
    }


def main():
    output = {}
    for argument in sys.argv[1:]:
        path = Path(argument)
        try:
            output[path.stem.lower()] = read_bundle(path)
        except Exception as error:
            print(f"{path.name}: {error}", file=sys.stderr)
    print(json.dumps(output, separators=(",", ":")))


if __name__ == "__main__":
    main()
