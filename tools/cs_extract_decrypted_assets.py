#!/usr/bin/env python3
"""
Extract readable Unity assets from decrypted CounterSide .asset.dec bundles.

The extractor creates one folder per decrypted bundle while preserving the source
tree below --root. It exports common asset types:
- Texture2D and Sprite as PNG
- TextAsset as its original bytes
- AudioClip sample files when UnityPy exposes them
- optional type-tree JSON for selected metadata-heavy object types
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    import UnityPy
except ImportError as exc:
    raise SystemExit("UnityPy is required: pip install UnityPy") from exc

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("Pillow is required: pip install pillow") from exc


DEFAULT_TYPES = {"Texture2D", "Sprite", "TextAsset", "AudioClip"}
DEFAULT_TREE_TYPES = {"MonoBehaviour", "Material", "Mesh", "GameObject"}
CUTSCENE_BG_TARGET_SIZE = (1920, 1080)
LANCZOS = getattr(Image.Resampling, "LANCZOS", Image.LANCZOS)


def safe_name(value: str | None, fallback: str = "unnamed") -> str:
    value = value or fallback
    value = re.sub(r"[^A-Za-z0-9._ -]+", "_", value).strip(" ._")
    value = value.replace(" ", "_")
    return value or fallback


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    index = 2
    while True:
        candidate = parent / f"{stem}_{index}{suffix}"
        if not candidate.exists():
            return candidate
        index += 1


def bundle_output_dir(path: Path, root: Path, out_dir: Path) -> Path:
    try:
        relative = path.resolve().relative_to(root.resolve())
    except ValueError:
        relative = Path(path.name)

    parts = list(relative.parts)
    filename = parts[-1]
    if filename.endswith(".asset.dec"):
        filename = filename[: -len(".asset.dec")]
    elif filename.endswith(".dec"):
        filename = filename[: -len(".dec")]
    parts[-1] = filename
    return out_dir.joinpath(*parts)


def text_asset_bytes(asset: Any) -> bytes:
    script = asset.m_Script
    if isinstance(script, bytes):
        return script
    return script.encode("utf-8", "surrogateescape")


def write_text_asset(asset: Any, out_dir: Path) -> list[dict[str, Any]]:
    name = safe_name(getattr(asset, "m_Name", None), "textasset")
    raw = text_asset_bytes(asset)
    ext = Path(name).suffix
    filename = name if ext else f"{name}.bytes"
    output = unique_path(out_dir / "TextAsset" / filename)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(raw)
    return [{"type": "TextAsset", "name": name, "path": str(output), "bytes": len(raw)}]


def write_texture(asset: Any, out_dir: Path, type_name: str) -> list[dict[str, Any]]:
    name = safe_name(getattr(asset, "m_Name", None), type_name.lower())
    image = asset.image
    output = unique_path(out_dir / type_name / f"{name}.png")
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)
    return [{"type": type_name, "name": name, "path": str(output), "size": list(image.size)}]


def is_cutscene_background_name(name: str | None) -> bool:
    return bool(name and safe_name(name).upper().startswith("AB_UI_NKM_UI_CUTSCEN_BG_"))


def write_cutscene_background_16x9(asset: Any, out_dir: Path) -> list[dict[str, Any]]:
    name = safe_name(getattr(asset, "m_Name", None), "sprite")
    if not is_cutscene_background_name(name):
        return []

    image = asset.image
    output = out_dir / "CutsceneBG16x9" / f"{name}.png"
    output.parent.mkdir(parents=True, exist_ok=True)
    image.resize(CUTSCENE_BG_TARGET_SIZE, LANCZOS).save(output)
    return [
        {
            "type": "Sprite:CutsceneBG16x9",
            "name": name,
            "path": str(output),
            "source_size": list(image.size),
            "size": list(CUTSCENE_BG_TARGET_SIZE),
        }
    ]


def write_audio(asset: Any, out_dir: Path) -> list[dict[str, Any]]:
    name = safe_name(getattr(asset, "m_Name", None), "audioclip")
    written: list[dict[str, Any]] = []
    samples = getattr(asset, "samples", None)
    if not samples:
        return written

    audio_dir = out_dir / "AudioClip" / name
    audio_dir.mkdir(parents=True, exist_ok=True)
    for sample_name, sample_data in samples.items():
        output = unique_path(audio_dir / safe_name(sample_name, "sample"))
        output.write_bytes(sample_data)
        written.append(
            {"type": "AudioClip", "name": name, "path": str(output), "bytes": len(sample_data)}
        )
    return written


def json_default(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"bytes": len(value)}
    if isinstance(value, (set, tuple)):
        return list(value)
    return str(value)


def compact_asset_metadata(asset: Any) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for key, value in vars(asset).items():
        if key.startswith("_"):
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            metadata[key] = value
        elif isinstance(value, bytes):
            metadata[key] = {"bytes": len(value)}
        elif isinstance(value, (list, tuple, dict)):
            try:
                json.dumps(value, default=json_default)
                metadata[key] = value
            except Exception:
                metadata[key] = str(value)
        else:
            metadata[key] = str(value)
    return metadata


def write_fallback_metadata(
    obj: Any,
    asset: Any,
    out_dir: Path,
    type_name: str,
    reason: str,
) -> list[dict[str, Any]]:
    name = safe_name(getattr(asset, "m_Name", None), type_name.lower())
    payload: dict[str, Any] = {
        "type": type_name,
        "name": name,
        "path_id": getattr(obj, "path_id", None),
        "fallback": True,
        "reason": reason,
        "metadata": compact_asset_metadata(asset),
    }
    try:
        payload["typetree"] = obj.read_typetree()
    except Exception as exc:
        payload["typetree_error"] = str(exc)

    output = unique_path(out_dir / f"{type_name}Meta" / f"{name}.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, default=json_default), encoding="utf-8")
    return [
        {
            "type": f"{type_name}:Metadata",
            "name": name,
            "path": str(output),
            "fallback": True,
            "reason": reason,
        }
    ]


def write_typetree(obj: Any, asset: Any, out_dir: Path) -> list[dict[str, Any]]:
    type_name = obj.type.name
    name = safe_name(getattr(asset, "m_Name", None), type_name.lower())
    try:
        tree = obj.read_typetree()
    except Exception:
        return []

    output = unique_path(out_dir / "TypeTree" / type_name / f"{name}.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(tree, indent=2, default=json_default), encoding="utf-8")
    return [{"type": f"{type_name}:TypeTree", "name": name, "path": str(output)}]


def paths_from_failed_manifest(manifest: Path, root: Path) -> list[Path]:
    data = json.loads(manifest.read_text(encoding="utf-8"))
    paths: list[Path] = []
    for entry in data.get("bundles", []):
        if not entry.get("errors"):
            continue
        source = Path(entry["source"])
        if not source.is_absolute():
            source = root / source
        if source.exists():
            paths.append(source.resolve())
    return sorted(dict.fromkeys(paths))


def paths_from_empty_manifest(manifest: Path, root: Path) -> list[Path]:
    data = json.loads(manifest.read_text(encoding="utf-8"))
    paths: list[Path] = []
    for entry in data.get("bundles", []):
        if entry.get("files") or entry.get("errors"):
            continue
        source = Path(entry["source"])
        if not source.is_absolute():
            source = root / source
        if source.exists():
            paths.append(source.resolve())
    return sorted(dict.fromkeys(paths))


def write_object_index(env: Any, out_dir: Path) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    type_counts: dict[str, int] = {}
    for obj in env.objects:
        type_name = obj.type.name
        type_counts[type_name] = type_counts.get(type_name, 0) + 1
        item: dict[str, Any] = {
            "path_id": getattr(obj, "path_id", None),
            "type": type_name,
        }
        try:
            asset = obj.read()
            name = getattr(asset, "m_Name", None)
            if name:
                item["name"] = name
        except Exception as exc:
            item["read_error"] = str(exc)
        objects.append(item)

    payload = {
        "object_count": len(objects),
        "type_counts": dict(sorted(type_counts.items())),
        "objects": objects,
    }
    output = out_dir / "ObjectIndex" / "objects.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, default=json_default), encoding="utf-8")
    return [{"type": "ObjectIndex", "name": "objects", "path": str(output), "objects": len(objects)}]


def extract_bundle(
    path: Path,
    root: Path,
    out_root: Path,
    enabled_types: set[str],
    tree_types: set[str],
    overwrite_manifest: bool,
    object_index_only: bool = False,
    cutscene_backgrounds_only: bool = False,
) -> dict[str, Any]:
    bundle_dir = bundle_output_dir(path, root, out_root)
    bundle_dir.mkdir(parents=True, exist_ok=True)

    entry: dict[str, Any] = {"source": str(path), "output": str(bundle_dir), "files": [], "errors": []}
    try:
        env = UnityPy.load(str(path))
    except Exception as exc:
        entry["errors"].append(f"load: {exc}")
        return entry

    if object_index_only:
        try:
            entry["files"].extend(write_object_index(env, bundle_dir))
        except Exception as exc:
            entry["errors"].append(f"ObjectIndex: {exc}")
        manifest = bundle_dir / "manifest.json"
        if overwrite_manifest or not manifest.exists():
            manifest.write_text(json.dumps(entry, indent=2), encoding="utf-8")
        return entry

    for obj in env.objects:
        type_name = obj.type.name
        if type_name not in enabled_types and type_name not in tree_types:
            continue
        try:
            asset = obj.read()
            if type_name == "Texture2D":
                try:
                    width = int(getattr(asset, "m_Width", 0) or 0)
                    height = int(getattr(asset, "m_Height", 0) or 0)
                    if width <= 0 or height <= 0:
                        raise ValueError(f"empty texture dimensions {width}x{height}")
                    entry["files"].extend(write_texture(asset, bundle_dir, type_name))
                except Exception as exc:
                    entry["files"].extend(
                        write_fallback_metadata(obj, asset, bundle_dir, type_name, str(exc))
                    )
            elif type_name == "Sprite":
                try:
                    if not cutscene_backgrounds_only:
                        entry["files"].extend(write_texture(asset, bundle_dir, type_name))
                    entry["files"].extend(write_cutscene_background_16x9(asset, bundle_dir))
                except Exception as exc:
                    entry["files"].extend(
                        write_fallback_metadata(obj, asset, bundle_dir, type_name, str(exc))
                    )
            elif type_name == "TextAsset":
                entry["files"].extend(write_text_asset(asset, bundle_dir))
            elif type_name == "AudioClip":
                entry["files"].extend(write_audio(asset, bundle_dir))
            elif type_name in tree_types:
                entry["files"].extend(write_typetree(obj, asset, bundle_dir))
        except Exception as exc:
            entry["errors"].append(f"{type_name}: {exc}")

    manifest = bundle_dir / "manifest.json"
    if overwrite_manifest or not manifest.exists():
        manifest.write_text(json.dumps(entry, indent=2), encoding="utf-8")
    return entry


def parse_types(raw: str | None, defaults: set[str]) -> set[str]:
    if raw is None:
        return set(defaults)
    if raw.strip().lower() in {"", "none", "off"}:
        return set()
    return {item.strip() for item in raw.split(",") if item.strip()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("decrypted-assets/CounterSide"),
        help="Root containing decrypted .asset.dec files",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("extracted-assets/all"),
        help="Output folder for extracted assets",
    )
    parser.add_argument("--pattern", default="*.asset.dec", help="File glob below --root")
    parser.add_argument(
        "--types",
        help="Comma-separated readable types to export; default Texture2D,Sprite,TextAsset,AudioClip",
    )
    parser.add_argument(
        "--type-tree",
        default="",
        help="Comma-separated types to export as JSON type trees, or omit for none",
    )
    parser.add_argument("--limit", type=int, default=0, help="Process at most this many bundles")
    parser.add_argument("--manifest", type=Path, help="Combined manifest path")
    parser.add_argument(
        "--failed-from-manifest",
        type=Path,
        help="Retry only bundles that have errors in a previous combined manifest",
    )
    parser.add_argument(
        "--empty-from-manifest",
        type=Path,
        help="Retry only bundles that produced no files and no errors in a previous combined manifest",
    )
    parser.add_argument(
        "--object-index-only",
        action="store_true",
        help="Write a lightweight object index for each selected bundle instead of exporting full assets",
    )
    parser.add_argument(
        "--cutscene-backgrounds-only",
        action="store_true",
        help="For Sprite exports, write only resized CutsceneBG16x9 images.",
    )
    parser.add_argument("--overwrite-manifest", action="store_true")
    parser.add_argument("--quiet", action="store_true", help="Print only the final summary")
    args = parser.parse_args()

    root = args.root.resolve()
    out_dir = args.out_dir.resolve()
    if not root.exists():
        raise FileNotFoundError(root)

    enabled_types = parse_types(args.types, DEFAULT_TYPES)
    tree_types = parse_types(args.type_tree, set())
    if args.failed_from_manifest and args.empty_from_manifest:
        raise ValueError("--failed-from-manifest and --empty-from-manifest are mutually exclusive")
    if args.failed_from_manifest:
        files = paths_from_failed_manifest(args.failed_from_manifest.resolve(), root)
    elif args.empty_from_manifest:
        files = paths_from_empty_manifest(args.empty_from_manifest.resolve(), root)
    else:
        files = sorted(root.rglob(args.pattern))
    if args.limit > 0:
        files = files[: args.limit]
    if not files:
        raise ValueError(f"no files matched {args.pattern} under {root}")

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_entries: list[dict[str, Any]] = []
    for index, path in enumerate(files, start=1):
        entry = extract_bundle(
            path,
            root,
            out_dir,
            enabled_types,
            tree_types,
            args.overwrite_manifest,
            args.object_index_only,
            args.cutscene_backgrounds_only,
        )
        manifest_entries.append(entry)
        if not args.quiet:
            print(
                f"[{index}/{len(files)}] files={len(entry['files'])} errors={len(entry['errors'])} {path}"
            )

    manifest_path = args.manifest or (out_dir / "manifest.json")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    summary = {
        "root": str(root),
        "out_dir": str(out_dir),
        "bundle_count": len(manifest_entries),
        "file_count": sum(len(entry["files"]) for entry in manifest_entries),
        "error_count": sum(len(entry["errors"]) for entry in manifest_entries),
        "bundles": manifest_entries,
    }
    manifest_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(
        f"done bundles={summary['bundle_count']} files={summary['file_count']} errors={summary['error_count']} manifest={manifest_path}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(0)
