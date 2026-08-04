#!/usr/bin/env python3
"""
Decrypt CounterSide asset bundles enough to extract encrypted Lua TextAssets.

This mirrors the client-side paths found in the decompiled C#:
- AssetBundles.AssetBundleManager.GetMaskList + NKCAssetbundleCryptoStream
  decrypt the first 212 bytes of the UnityFS bundle.
- NKM.NKMLua.GetEncryptedFileName uses EasyStrConverter for TextAsset names.
- Cs.Memory.Crypto2.Decrypt decrypts the TextAsset bytes into compiled Lua.

The output Lua is bytecode, not source, but strings/constants are searchable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

try:
    import UnityPy
except ImportError:
    UnityPy = None


ASSET_BUNDLE_HEADER_DECRYPT_SIZE = 212

CRYPTO2_MASKS = [
    14003937370121879411,
    295159725236528685,
    14656252856989855980,
    3126201044280739051,
    6176412274767465921,
    8501111619623644353,
    1001882303165547266,
    889784367385610816,
    8403001398375820177,
    15646421979254498160,
    15540104736269140030,
    4473111575030559303,
    16641115610173278858,
    7005653296469604124,
    7641466651897675454,
    18242667629599333687,
]

ODD_MASK = 6148914691236517205
EVEN_MASK = 12297829382473034410
MASK64 = (1 << 64) - 1


def get_bundle_masks(path: Path) -> list[int]:
    name = path.with_suffix("").name.lower()
    digest = hashlib.md5(name.encode("utf-8")).hexdigest()
    return [
        int(digest[0:16], 16),
        int(digest[16:32], 16),
        int(digest[0:8] + digest[16:24], 16),
        int(digest[8:16] + digest[24:32], 16),
    ]


def transform_bundle_header(data: bytes, path: Path) -> bytes:
    data = bytearray(data)
    masks = get_bundle_masks(path)
    mask_index = 0
    offset = 0
    size = min(len(data), ASSET_BUNDLE_HEADER_DECRYPT_SIZE)

    while offset < size:
        mask = masks[mask_index]
        remaining = size - offset
        if remaining >= 8:
            value = int.from_bytes(data[offset : offset + 8], "little") ^ mask
            data[offset : offset + 8] = value.to_bytes(8, "little")
            offset += 8
        else:
            low_byte = mask & 0xFF
            for index in range(offset, size):
                data[index] ^= low_byte
            offset = size

        mask_index = (mask_index + 1) % len(masks)

    return bytes(data)


def decrypt_bundle_header(path: Path) -> bytes:
    return transform_bundle_header(path.read_bytes(), path)


def crypto2_decrypt(data: bytes) -> bytes:
    buffer = bytearray(data)
    mask_index = 0
    offset = 0

    while offset < len(buffer):
        mask = CRYPTO2_MASKS[mask_index]
        remaining = len(buffer) - offset
        if remaining >= 8:
            value = int.from_bytes(buffer[offset : offset + 8], "little")
            value = (
                (value & 0xFFFFFFFF00000000)
                | ((value & 0xFF000000) >> 8)
                | ((value & 0x00FF0000) << 8)
                | ((value & 0x0000FF00) >> 8)
                | ((value & 0x000000FF) << 8)
            )
            odd = value & ODD_MASK
            value = ((value & EVEN_MASK) >> 1) | ((odd << 1) & MASK64)
            value = (value ^ mask) & MASK64
            buffer[offset : offset + 8] = value.to_bytes(8, "little")
            offset += 8
        else:
            low_byte = mask & 0xFF
            for index in range(offset, len(buffer)):
                buffer[index] ^= low_byte
            offset = len(buffer)

        mask_index = (mask_index + 1) % len(CRYPTO2_MASKS)

    return bytes(buffer)


def crypto2_encrypt(data: bytes) -> bytes:
    buffer = bytearray(data)
    mask_index = 0
    offset = 0

    while offset < len(buffer):
        mask = CRYPTO2_MASKS[mask_index]
        remaining = len(buffer) - offset
        if remaining >= 8:
            value = int.from_bytes(buffer[offset : offset + 8], "little") ^ mask
            odd = value & ODD_MASK
            value = ((value & EVEN_MASK) >> 1) | ((odd << 1) & MASK64)
            value = (
                (value & 0xFFFFFFFF00000000)
                | ((value & 0xFF000000) >> 8)
                | ((value & 0x00FF0000) << 8)
                | ((value & 0x0000FF00) >> 8)
                | ((value & 0x000000FF) << 8)
            )
            buffer[offset : offset + 8] = value.to_bytes(8, "little")
            offset += 8
        else:
            low_byte = mask & 0xFF
            for index in range(offset, len(buffer)):
                buffer[index] ^= low_byte
            offset = len(buffer)

        mask_index = (mask_index + 1) % len(CRYPTO2_MASKS)

    return bytes(buffer)


def csharp_remainder(value: int, divisor: int) -> int:
    return value - int(value / divisor) * divisor


def shift_char_range(codepoint: int, amount: int, minimum: int, maximum: int) -> int:
    span = maximum - minimum
    shift = csharp_remainder(amount, span)
    if shift == 0:
        if amount > 0:
            shift += 2
        elif amount < 0:
            shift -= 2

    shifted = codepoint + shift
    if shifted > maximum:
        return minimum + (shifted % maximum) - 1
    if shifted < minimum:
        return maximum - (minimum % shifted) + 1
    return shifted


def shift_char(ch: str, amount: int) -> str:
    codepoint = ord(ch)
    if "A" <= ch <= "Z":
        return chr(shift_char_range(codepoint, amount, ord("A"), ord("Z")))
    if "a" <= ch <= "z":
        return chr(shift_char_range(codepoint, amount, ord("a"), ord("z")))
    if "0" <= ch <= "9":
        return chr(shift_char_range(codepoint, amount, ord("0"), ord("9")))
    return ch


def convert_name(name: str, decrypt: bool = False) -> str:
    amount = -len(name) if decrypt else len(name)
    return "".join(shift_char(ch, amount) for ch in name)


def encrypted_lua_name(lua_name: str) -> str:
    if lua_name.endswith("_c"):
        lua_name = lua_name[:-2]
    return convert_name(lua_name, decrypt=False) + "_c"


def decrypted_lua_name(asset_name: str) -> str:
    suffix = "_c" if asset_name.endswith("_c") else ""
    base = asset_name[:-2] if suffix else asset_name
    return convert_name(base, decrypt=True) + suffix


def load_bundle(path: Path):
    if UnityPy is None:
        raise RuntimeError("UnityPy is required for bundle TextAsset commands: pip install UnityPy")
    return UnityPy.load(decrypt_bundle_header(path))


def text_asset_bytes(text_asset) -> bytes:
    script = text_asset.m_Script
    if isinstance(script, bytes):
        return script
    return script.encode("utf-8", "surrogateescape")


def iter_text_assets(bundle: Path):
    env = load_bundle(bundle)
    for obj in env.objects:
        if obj.type.name != "TextAsset":
            continue
        yield obj.read()


def extract_text_asset(bundle: Path, name: str, name_is_plain: bool = True) -> tuple[str, bytes]:
    wanted = encrypted_lua_name(name) if name_is_plain else name
    for asset in iter_text_assets(bundle):
        if asset.m_Name == wanted:
            return wanted, crypto2_decrypt(text_asset_bytes(asset))
    raise KeyError(f"TextAsset not found: {wanted}")


def extract_strings(data: bytes, min_length: int = 4) -> list[str]:
    pattern = rb"[ -~]{" + str(min_length).encode("ascii") + rb",}"
    return [match.group(0).decode("ascii", "replace") for match in re.finditer(pattern, data)]


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
    return out_dir.joinpath(*relative.parts)


def dump_script_bundle(path: Path, root: Path, out_dir: Path, strings: bool, overwrite: bool) -> dict:
    bundle_dir = bundle_output_dir(path, root, out_dir)
    bundle_dir.mkdir(parents=True, exist_ok=True)
    entry = {"source": str(path), "output": str(bundle_dir), "files": [], "errors": []}
    try:
        assets = list(iter_text_assets(path))
    except Exception as exc:
        entry["errors"].append(f"load: {exc}")
        return entry

    for asset in assets:
        encrypted_name = asset.m_Name
        plain_name = decrypted_lua_name(encrypted_name)
        filename = safe_name(plain_name)
        if filename.endswith("_c"):
            filename = filename[:-2]
        try:
            data = crypto2_decrypt(text_asset_bytes(asset))
            luac_path = bundle_dir / "luac" / f"{filename}.luac"
            if luac_path.exists() and not overwrite:
                luac_path = unique_path(luac_path)
            luac_path.parent.mkdir(parents=True, exist_ok=True)
            luac_path.write_bytes(data)
            item = {
                "type": "LuaBytecode",
                "name": plain_name,
                "encryptedName": encrypted_name,
                "path": str(luac_path),
                "bytes": len(data),
            }

            if strings:
                strings_path = bundle_dir / "strings" / f"{filename}.strings.txt"
                if strings_path.exists() and not overwrite:
                    strings_path = unique_path(strings_path)
                strings_path.parent.mkdir(parents=True, exist_ok=True)
                values = extract_strings(data)
                strings_path.write_text("\n".join(values) + ("\n" if values else ""), encoding="utf-8")
                item["stringsPath"] = str(strings_path)
                item["stringCount"] = len(values)

            entry["files"].append(item)
        except Exception as exc:
            entry["errors"].append(f"{plain_name}: {exc}")

    manifest = bundle_dir / "manifest.json"
    manifest.write_text(json.dumps(entry, indent=2), encoding="utf-8")
    return entry


def dump_script_bundles(args: argparse.Namespace) -> None:
    root = args.root.resolve()
    out_dir = args.out_dir.resolve()
    if not root.exists():
        raise FileNotFoundError(root)

    paths = [path for path in sorted(root.rglob(args.pattern)) if path.is_file()]
    if args.limit > 0:
        paths = paths[: args.limit]
    if not paths:
        raise ValueError(f"no files matched {args.pattern} under {root}")

    out_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for index, path in enumerate(paths, start=1):
        entry = dump_script_bundle(path, root, out_dir, args.strings, args.overwrite)
        entries.append(entry)
        print(f"[{index}/{len(paths)}] files={len(entry['files'])} errors={len(entry['errors'])} {path}")

    summary = {
        "root": str(root),
        "out_dir": str(out_dir),
        "bundle_count": len(entries),
        "file_count": sum(len(entry["files"]) for entry in entries),
        "error_count": sum(len(entry["errors"]) for entry in entries),
        "bundles": entries,
    }
    manifest_path = args.manifest or (out_dir / "manifest.json")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(
        f"done bundles={summary['bundle_count']} files={summary['file_count']} "
        f"errors={summary['error_count']} manifest={manifest_path}"
    )


def int64_constant(value: int) -> bytes:
    return b"\x03" + int(value).to_bytes(8, "little", signed=True)


def find_dungeon_map_str(dungeon_data: bytes, dungeon_id: int) -> str:
    marker = int64_constant(dungeon_id)
    start = dungeon_data.find(marker)
    if start < 0:
        raise ValueError(f"dungeon id {dungeon_id} not found in dungeon bytecode")

    window = dungeon_data[start : start + 2500]
    matches = list(re.finditer(rb"AB_MAP_GAME_[A-Z0-9_]+", window))
    if not matches:
        raise ValueError(f"no AB_MAP_GAME_* string found near dungeon id {dungeon_id}")
    return matches[0].group(0).decode("ascii")


def find_map_id(map_data: bytes, map_str_id: str) -> int:
    needle = map_str_id.encode("ascii")
    index = map_data.find(needle)
    if index < 0:
        raise ValueError(f"map string not found: {map_str_id}")

    best: tuple[int, int] | None = None
    scan_start = max(0, index - 160)
    for pos in range(scan_start, index):
        if map_data[pos] != 0x03 or pos + 9 > len(map_data):
            continue
        value = int.from_bytes(map_data[pos + 1 : pos + 9], "little", signed=True)
        if 0 < value < 100000:
            distance = index - pos
            if best is None or distance < best[1]:
                best = (value, distance)

    if best is None:
        raise ValueError(f"no nearby numeric map id found for {map_str_id}")
    return best[0]


def resolve_dungeon_map(args: argparse.Namespace) -> None:
    _, dungeon_data = extract_text_asset(
        args.dungeon_bundle,
        args.dungeon_asset,
        name_is_plain=not args.dungeon_asset_encrypted,
    )
    _, map_data = extract_text_asset(
        args.map_bundle,
        args.map_asset,
        name_is_plain=not args.map_asset_encrypted,
    )
    map_str = find_dungeon_map_str(dungeon_data, args.dungeon_id)
    map_id = find_map_id(map_data, map_str)
    print(f"dungeonID={args.dungeon_id}")
    print(f"mapStrID={map_str}")
    print(f"mapID={map_id}")


def decrypt_header_file(
    path: Path,
    suffix: str = ".dec",
    overwrite: bool = False,
    root: Path | None = None,
    out_dir: Path | None = None,
) -> Path:
    if not path.exists():
        raise FileNotFoundError(path)

    if out_dir is not None:
        base = root.resolve() if root is not None else path.parent.resolve()
        try:
            relative = path.resolve().relative_to(base)
        except ValueError:
            relative = Path(path.name)
        output = out_dir / relative
        output = output.with_name(output.name + suffix)
    else:
        output = Path(str(path) + suffix)

    if output.exists() and not overwrite:
        raise FileExistsError(f"{output} already exists; pass --overwrite to replace it")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(decrypt_bundle_header(path))
    return output


def decrypt_header_files(args: argparse.Namespace) -> None:
    paths: list[Path] = list(args.files)
    if args.all_assets:
        scan_root = args.root if args.root is not None else Path(".")
        paths.extend(sorted(scan_root.rglob("*.asset")))

    if not paths:
        raise ValueError("no files supplied; pass files or use --all-assets")

    seen: set[Path] = set()
    count = 0
    for index, path in enumerate(paths, start=1):
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        output = decrypt_header_file(path, args.suffix, args.overwrite, args.root, args.out_dir)
        count += 1
        if not args.quiet:
            print(f"[{index}/{len(paths)}] wrote {output}")
    print(f"done count={count}")


def patch_script_bundle(args: argparse.Namespace) -> None:
    source = args.bundle.resolve()
    replacements = args.replacement_dir.resolve()
    output = args.out.resolve()
    if output.name != source.name:
        raise ValueError(f"output must keep the encrypted bundle name {source.name}: {output}")

    replacement_files = {path.stem: path for path in replacements.glob("*.luac") if path.is_file()}
    if not replacement_files:
        raise ValueError(f"no .luac replacements found in {replacements}")

    environment = load_bundle(source)
    changed: dict[str, bytes] = {}
    found: set[str] = set()
    for obj in environment.objects:
        if obj.type.name != "TextAsset":
            continue
        asset = obj.read()
        plain_name = decrypted_lua_name(asset.m_Name).removesuffix("_c")
        replacement = replacement_files.get(plain_name)
        if replacement is None:
            continue
        found.add(plain_name)
        replacement_data = replacement.read_bytes()
        if crypto2_decrypt(text_asset_bytes(asset)) == replacement_data:
            continue
        asset.m_Script = crypto2_encrypt(replacement_data).decode("utf-8", "surrogateescape")
        asset.save()
        changed[plain_name] = replacement_data

    if not found:
        raise ValueError(f"none of the replacement scripts exist in {source}")

    bundle = next((item for item in environment.files.values() if hasattr(item, "save")), None)
    if bundle is None:
        raise ValueError(f"Unity bundle was not found in {source}")
    target_size = args.output_size or (source.stat().st_size if args.preserve_size else 0)
    packed = bundle.save(packer="original")
    packer = "original"
    if target_size and len(packed) > target_size:
        packed = bundle.save(packer="lzma")
        packer = "lzma"
    if target_size and len(packed) > target_size:
        raise ValueError(f"patched bundle exceeds target size: {len(packed)} > {target_size}")

    encrypted = transform_bundle_header(packed, output)
    if target_size:
        encrypted += b"\0" * (target_size - len(encrypted))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(encrypted)

    verified = load_bundle(output)
    remaining = dict(changed)
    for obj in verified.objects:
        if obj.type.name != "TextAsset":
            continue
        asset = obj.read()
        plain_name = decrypted_lua_name(asset.m_Name).removesuffix("_c")
        expected = remaining.get(plain_name)
        if expected is not None and crypto2_decrypt(text_asset_bytes(asset)) == expected:
            del remaining[plain_name]
    if remaining:
        raise ValueError(f"patched scripts failed verification: {', '.join(sorted(remaining))}")

    print(
        f"patched={len(changed)} matched={len(found)} packer={packer} "
        f"bytes={output.stat().st_size} sha256={hashlib.sha256(output.read_bytes()).hexdigest()} out={output}"
    )


def _pointer_id(value: object) -> int:
    return int(value.get("m_PathID", 0)) if isinstance(value, dict) else 0


def _atlas_pages(text: str) -> tuple[list[str], list[int], list[str], str, bool]:
    newline = "\r\n" if "\r\n" in text else "\n"
    trailing = text.endswith(("\n", "\r"))
    lines = text.splitlines()
    indexes = [
        index for index, line in enumerate(lines[:-1])
        if line.strip() == line and line and lines[index + 1].startswith("size:")
    ]
    return [lines[index] for index in indexes], indexes, lines, newline, trailing


def _spine_binary_version(data: bytes) -> str:
    def read_string(offset: int) -> tuple[str, int]:
        length = 0
        shift = 0
        while True:
            if offset >= len(data) or shift > 28:
                raise ValueError("invalid Spine binary string")
            value = data[offset]
            offset += 1
            length |= (value & 0x7F) << shift
            if value & 0x80 == 0:
                break
            shift += 7
        if length <= 1:
            return "", offset
        end = offset + length - 1
        if end > len(data):
            raise ValueError("truncated Spine binary string")
        return data[offset:end].decode("utf-8", "replace"), end

    _, offset = read_string(0)
    version, _ = read_string(offset)
    return version


def _main_texture_id(material_tree: dict) -> int:
    entries = material_tree.get("m_SavedProperties", {}).get("m_TexEnvs", [])
    for entry in entries:
        if isinstance(entry, (list, tuple)) and len(entry) == 2:
            name, value = entry
        elif isinstance(entry, dict):
            name, value = entry.get("first"), entry.get("second", {})
        else:
            continue
        if name == "_MainTex":
            return _pointer_id(value.get("m_Texture", {}))
    return 0


def patch_spine_bundle(args: argparse.Namespace) -> None:
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("Pillow is required for Spine texture imports") from exc

    skeleton_data = args.skeleton.read_bytes()
    version = _spine_binary_version(skeleton_data)
    if not version.startswith("3.7."):
        raise ValueError(f"CounterSide requires a Spine 3.7 binary .skel; uploaded version is {version or 'unknown'}")
    atlas_text = args.atlas.read_text(encoding="utf-8-sig")
    uploaded_pages, uploaded_indexes, uploaded_lines, _, _ = _atlas_pages(atlas_text)
    if not uploaded_pages:
        raise ValueError("the uploaded .atlas has no PNG pages")
    textures = {path.name.lower(): path for path in args.textures}
    wanted_pages = {Path(name).name.lower() for name in uploaded_pages}
    if set(textures) != wanted_pages:
        raise ValueError(f"select exactly the atlas PNG pages: {', '.join(uploaded_pages)}")

    environment = load_bundle(args.bundle)
    objects = {obj.path_id: obj for obj in environment.objects}
    script_names = {
        obj.path_id: getattr(obj.read(), "m_Name", "")
        for obj in environment.objects if obj.type.name == "MonoScript"
    }
    game_object_names = {
        obj.path_id: getattr(obj.read(), "m_Name", "")
        for obj in environment.objects if obj.type.name == "GameObject"
    }
    script_name = "SkeletonAnimation" if args.kind == "battle" else "SkeletonGraphic"
    preferred_object = "SPINE_SkeletonAnimation" if args.kind == "battle" else "SPINE_SkeletonGraphic"
    components: list[tuple[bool, object, dict]] = []
    for obj in environment.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        if script_names.get(_pointer_id(tree.get("m_Script"))) != script_name:
            continue
        name = game_object_names.get(_pointer_id(tree.get("m_GameObject")), "")
        components.append((name.casefold() == preferred_object.casefold(), obj, tree))
    if not components:
        raise ValueError(f"source bundle has no {script_name} component")
    _, _, component = max(components, key=lambda item: item[0])
    skeleton_asset = objects.get(_pointer_id(component.get("skeletonDataAsset")))
    if skeleton_asset is None:
        raise ValueError("source Spine component has no SkeletonDataAsset")
    skeleton_tree = skeleton_asset.read_typetree()
    skeleton_text = objects.get(_pointer_id(skeleton_tree.get("skeletonJSON")))
    atlas_ids = [_pointer_id(value) for value in skeleton_tree.get("atlasAssets", [])]
    if skeleton_text is None or len(atlas_ids) != 1 or atlas_ids[0] not in objects:
        raise ValueError("source Spine prefab must use one editable skeleton and atlas asset")
    atlas_asset = objects[atlas_ids[0]]
    atlas_tree = atlas_asset.read_typetree()
    atlas_text_asset = objects.get(_pointer_id(atlas_tree.get("atlasFile")))
    if atlas_text_asset is None:
        raise ValueError("source Spine atlas TextAsset was not found")
    source_atlas = text_asset_bytes(atlas_text_asset.read()).decode("utf-8-sig")
    source_pages, source_indexes, source_lines, newline, trailing = _atlas_pages(source_atlas)
    material_ids = [_pointer_id(value) for value in atlas_tree.get("materials", [])]
    texture_objects = []
    for material_id in material_ids:
        material = objects.get(material_id)
        texture = objects.get(_main_texture_id(material.read_typetree())) if material else None
        if texture is not None and texture.type.name == "Texture2D":
            texture_objects.append(texture)
    if len(source_pages) != len(uploaded_pages) or len(texture_objects) != len(source_pages):
        raise ValueError(f"uploaded atlas has {len(uploaded_pages)} page(s), but the selected source unit prefab requires {len(source_pages)}")

    uploaded_page_paths = {Path(name).name.lower(): textures[Path(name).name.lower()] for name in uploaded_pages}
    for index, source_page in enumerate(source_pages):
        uploaded_page = uploaded_pages[index]
        source_lines[source_indexes[index]] = source_page
        with Image.open(uploaded_page_paths[Path(uploaded_page).name.lower()]) as image:
            if image.format != "PNG":
                raise ValueError(f"Spine atlas texture is not a PNG: {uploaded_page}")
            size = re.fullmatch(r"size:\s*(\d+)\s*,\s*(\d+)", uploaded_lines[uploaded_indexes[index] + 1])
            expected_size = (int(size.group(1)), int(size.group(2))) if size else None
            if expected_size is None or image.size != expected_size:
                raise ValueError(f"{uploaded_page} must be the atlas size {expected_size or 'width,height'}, got {image.size}")
            texture = texture_objects[index].read()
            texture.image = image.convert("RGBA")
            texture.save()

    skeleton = skeleton_text.read()
    skeleton.m_Script = skeleton_data.decode("utf-8", "surrogateescape")
    skeleton.save()
    atlas = atlas_text_asset.read()
    atlas.m_Script = newline.join(source_lines) + (newline if trailing else "")
    atlas.save()

    bundle_object = next((obj for obj in environment.objects if obj.type.name == "AssetBundle"), None)
    if bundle_object is None:
        raise ValueError("source AssetBundle metadata was not found")
    bundle_tree = bundle_object.read_typetree()
    renamed = False
    container = []
    for key, value in bundle_tree.get("m_Container", []):
        asset = objects.get(_pointer_id(value.get("asset")))
        if not renamed and Path(key).stem.casefold() == args.source_asset_name.casefold() and asset is not None and asset.type.name == "GameObject":
            game_object = asset.read()
            game_object.m_Name = args.asset_name
            game_object.save()
            key = str(Path(key).with_name(f"{args.asset_name}{Path(key).suffix}")).replace("\\", "/").lower()
            renamed = True
        container.append((key, value))
    if not renamed:
        raise ValueError(f"source prefab asset was not found: {args.source_asset_name}")
    bundle_tree["m_Container"] = container
    bundle_tree["m_Name"] = f"{args.bundle_name.lower()}.asset"
    bundle_tree["m_AssetBundleName"] = args.bundle_name.lower()
    bundle_object.save_typetree(bundle_tree)

    bundle = next((item for item in environment.files.values() if hasattr(item, "save")), None)
    if bundle is None:
        raise ValueError("Unity bundle was not found in the selected source")
    packed = bundle.save(packer="original")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(transform_bundle_header(packed, args.out))
    verified = load_bundle(args.out)
    if not any(obj.type.name == "GameObject" and getattr(obj.read(), "m_Name", "").casefold() == args.asset_name.casefold() for obj in verified.objects):
        raise ValueError("patched Spine bundle verification failed")
    print(json.dumps({
        "output": str(args.out),
        "bytes": args.out.stat().st_size,
        "spineVersion": version,
        "pages": uploaded_pages,
        "kind": args.kind,
        "bundleName": args.bundle_name,
        "assetName": args.asset_name,
    }))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    list_cmd = sub.add_parser("list", help="List TextAssets in a bundle")
    list_cmd.add_argument("bundle", type=Path)

    extract_cmd = sub.add_parser("extract", help="Extract and decrypt one Lua TextAsset")
    extract_cmd.add_argument("bundle", type=Path)
    extract_cmd.add_argument("asset", help="Plain Lua name by default, e.g. LUA_MAP_TEMPLET")
    extract_cmd.add_argument("-e", "--encrypted-name", action="store_true")
    extract_cmd.add_argument("-o", "--out", type=Path)
    extract_cmd.add_argument("--strings", action="store_true")

    search_cmd = sub.add_parser("search", help="Search decrypted TextAssets in a bundle")
    search_cmd.add_argument("bundle", type=Path)
    search_cmd.add_argument("needle")

    resolve_cmd = sub.add_parser("resolve-dungeon-map", help="Resolve dungeonID -> mapStrID -> mapID")
    resolve_cmd.add_argument("dungeon_id", type=int)
    resolve_cmd.add_argument("--dungeon-bundle", type=Path, required=True)
    resolve_cmd.add_argument("--map-bundle", type=Path, required=True)
    resolve_cmd.add_argument("--dungeon-asset", default="LUA_DUNGEON_TEMPLET_BASE")
    resolve_cmd.add_argument("--map-asset", default="LUA_MAP_TEMPLET")
    resolve_cmd.add_argument("--dungeon-asset-encrypted", action="store_true")
    resolve_cmd.add_argument("--map-asset-encrypted", action="store_true")

    header_cmd = sub.add_parser("decrypt-header", help="Decrypt the first 212 bytes of asset files and write .dec files")
    header_cmd.add_argument("files", nargs="*", type=Path)
    header_cmd.add_argument("--all-assets", action="store_true", help="Decrypt all *.asset files in the current directory")
    header_cmd.add_argument("--root", type=Path, help="Root used for --all-assets scanning and output relative paths")
    header_cmd.add_argument("--out-dir", type=Path, help="Write decrypted files into this folder preserving paths under --root")
    header_cmd.add_argument("--suffix", default=".dec")
    header_cmd.add_argument("--overwrite", action="store_true")
    header_cmd.add_argument("--quiet", action="store_true", help="Print only the final summary")

    dump_cmd = sub.add_parser("dump-scripts", help="Dump all decrypted Lua TextAssets from script bundles")
    dump_cmd.add_argument("--root", type=Path, required=True, help="Root containing ab_script* bundles")
    dump_cmd.add_argument("--out-dir", type=Path, required=True, help="Output folder")
    dump_cmd.add_argument("--pattern", default="ab_script*", help="File glob below --root")
    dump_cmd.add_argument("--manifest", type=Path, help="Combined manifest path")
    dump_cmd.add_argument("--strings", action="store_true", help="Also write printable string dumps")
    dump_cmd.add_argument("--limit", type=int, default=0)
    dump_cmd.add_argument("--overwrite", action="store_true")

    patch_cmd = sub.add_parser("patch-scripts", help="Replace Lua TextAssets in an encrypted script bundle")
    patch_cmd.add_argument("--bundle", type=Path, required=True)
    patch_cmd.add_argument("--replacement-dir", type=Path, required=True)
    patch_cmd.add_argument("--out", type=Path, required=True)
    patch_cmd.add_argument("--preserve-size", action="store_true")
    patch_cmd.add_argument("--output-size", type=int, default=0)

    spine_cmd = sub.add_parser("patch-spine", help="Clone a CounterSide Spine prefab bundle and replace its skeleton, atlas, and PNG pages")
    spine_cmd.add_argument("--bundle", type=Path, required=True)
    spine_cmd.add_argument("--skeleton", type=Path, required=True)
    spine_cmd.add_argument("--atlas", type=Path, required=True)
    spine_cmd.add_argument("--textures", nargs="+", type=Path, required=True)
    spine_cmd.add_argument("--kind", choices=("graphic", "battle"), required=True)
    spine_cmd.add_argument("--source-asset-name", required=True)
    spine_cmd.add_argument("--bundle-name", required=True)
    spine_cmd.add_argument("--asset-name", required=True)
    spine_cmd.add_argument("--out", type=Path, required=True)

    args = parser.parse_args()

    if args.cmd == "list":
        for asset in iter_text_assets(args.bundle):
            print(f"{asset.m_Name}\t{decrypted_lua_name(asset.m_Name)}\t{len(text_asset_bytes(asset))}")
        return 0

    if args.cmd == "extract":
        encrypted_name, data = extract_text_asset(args.bundle, args.asset, not args.encrypted_name)
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_bytes(data)
            print(f"wrote {args.out} ({len(data)} bytes) from {encrypted_name}")
        elif args.strings:
            for value in extract_strings(data):
                print(value)
        else:
            sys.stdout.buffer.write(data)
        return 0

    if args.cmd == "search":
        needle = args.needle.encode("utf-8")
        for asset in iter_text_assets(args.bundle):
            data = crypto2_decrypt(text_asset_bytes(asset))
            if needle in data:
                print(f"{asset.m_Name}\t{decrypted_lua_name(asset.m_Name)}\t{len(data)}")
        return 0

    if args.cmd == "resolve-dungeon-map":
        resolve_dungeon_map(args)
        return 0

    if args.cmd == "decrypt-header":
        decrypt_header_files(args)
        return 0

    if args.cmd == "dump-scripts":
        dump_script_bundles(args)
        return 0

    if args.cmd == "patch-scripts":
        patch_script_bundle(args)
        return 0

    if args.cmd == "patch-spine":
        patch_spine_bundle(args)
        return 0

    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(0)
