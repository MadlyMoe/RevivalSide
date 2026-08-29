#!/usr/bin/env python3
"""Build Counter:Side's native ExtraAsset Lua cache from Android bundles."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import tempfile
import zipfile
from pathlib import Path

from cs_asset_decrypt import crypto2_decrypt, crypto2_encrypt, decrypted_lua_name, encrypted_lua_name
from cs_lua_table_pipeline import parse_lua_table

try:
    import UnityPy
except ImportError:
    UnityPy = None


HEADER_SIZE = 212
COUNTER_PASS_TABLE = "AB_SCRIPT/LUA_CONTENTS_UNLOCK_TEMPLET.LUAC"
COUNTER_PASS_PATCH = "counter-pass-always-unlocked"
OPERATOR_CONTRACT_TABLE = "AB_SCRIPT/LUA_CONTRACT.LUAC"
OPERATOR_TAB_TABLE = "AB_SCRIPT/LUA_CONTRACT_TAB_TABLE.LUAC"
OPERATOR_CATEGORY_PATCH = "operator-contract-category"


def run_unluac(jar: Path, arguments: list[str]) -> None:
    result = subprocess.run(
        ["java", "-jar", str(jar), *arguments],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip() or "unluac failed")


def patch_counter_pass_unlock(body: bytes, unluac_jar: Path) -> bytes:
    if not unluac_jar.is_file():
        raise FileNotFoundError(f"Counter Pass parity patch requires {unluac_jar}")
    with tempfile.TemporaryDirectory(prefix="revivalside-counter-pass-") as temporary:
        root = Path(temporary)
        source = root / "source.luac"
        listing = root / "source.disassembly"
        patched = root / "patched.luac"
        source.write_bytes(body)
        run_unluac(unluac_jar, ["--disassemble", "--output", str(listing), str(source)])
        lines = listing.read_text(encoding="utf-8").splitlines()
        constants: dict[str, str] = {}
        for line in lines:
            match = re.match(r'^\s*\.constant\s+(k\d+)\s+"([^"]+)"\s*$', line)
            if match:
                constants[match.group(2)] = match.group(1)
        required = ("COUNTER_PASS", "eContentsType", "m_UnlockReqType", "m_UnlockReqValue", "SURT_ALWAYS_UNLOCKED")
        missing = [name for name in required if name not in constants]
        if missing:
            raise ValueError(f"Counter Pass parity constants are missing: {', '.join(missing)}")
        max_stack_line = next((line for line in lines if re.match(r"^\s*\.maxstacksize\s+\d+\s*$", line)), "")
        max_stack_match = re.match(r"^\s*\.maxstacksize\s+(\d+)\s*$", max_stack_line)
        if not max_stack_match or int(max_stack_match.group(1)) < 2:
            raise ValueError("Counter Pass Lua table has no usable temporary register")
        temporary_register = f"r{int(max_stack_match.group(1)) - 1}"
        counter_pass_line = re.compile(
            rf"^\s*setfield\s+(r\d+)\s+{re.escape(constants['eContentsType'])}\s+"
            rf"{re.escape(constants['COUNTER_PASS'])}\s+k=\s*1(?:\s*;.*)?$"
        )
        record_index = -1
        record_register = ""
        for index, line in enumerate(lines):
            match = counter_pass_line.match(line)
            if match:
                if record_index >= 0:
                    raise ValueError("Counter Pass Lua table contains multiple COUNTER_PASS records")
                record_index = index
                record_register = match.group(1)
        if record_index < 0:
            raise ValueError("Counter Pass Lua record was not found")
        if temporary_register == record_register:
            raise ValueError("Counter Pass Lua table has no free temporary register")
        unlock_type_index = -1
        unlock_value_index = -1
        for index in range(record_index + 1, min(len(lines), record_index + 12)):
            if re.match(
                rf"^\s*setfield\s+{re.escape(record_register)}\s+{re.escape(constants['m_UnlockReqType'])}\s+",
                lines[index],
            ):
                unlock_type_index = index
            if re.match(
                rf"^\s*setfield\s+{re.escape(record_register)}\s+{re.escape(constants['m_UnlockReqValue'])}\s+",
                lines[index],
            ):
                unlock_value_index = index
        if unlock_type_index < 0 or unlock_value_index < 0 or unlock_type_index >= unlock_value_index:
            raise ValueError("Counter Pass unlock instructions were not found")
        lines[unlock_type_index] = (
            f"  loadk        {temporary_register}  {constants['SURT_ALWAYS_UNLOCKED']}"
            f" ; {constants['SURT_ALWAYS_UNLOCKED']} = \"SURT_ALWAYS_UNLOCKED\""
        )
        lines[unlock_value_index] = (
            f"  setfield     {record_register}  {constants['m_UnlockReqType']}  {temporary_register}"
            f" ; {constants['m_UnlockReqType']} = \"m_UnlockReqType\""
        )
        listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
        run_unluac(unluac_jar, ["--assemble", "--output", str(patched), str(listing)])
        run_unluac(unluac_jar, [str(patched)])
        return patched.read_bytes()


def decompile_records(body: bytes, unluac_jar: Path, root: Path, name: str) -> list[dict[str, object]]:
    source = root / f"{name}.luac"
    decompiled = root / f"{name}.lua"
    source.write_bytes(body)
    run_unluac(unluac_jar, ["--output", str(decompiled), str(source)])
    return list(parse_lua_table(decompiled)["records"])


def patch_operator_contract_categories(contract_body: bytes, tab_body: bytes, unluac_jar: Path) -> bytes:
    if not unluac_jar.is_file():
        raise FileNotFoundError(f"Operator contract parity patch requires {unluac_jar}")
    with tempfile.TemporaryDirectory(prefix="revivalside-operator-contract-") as temporary:
        root = Path(temporary)
        contracts = decompile_records(contract_body, unluac_jar, root, "contracts")
        tabs = decompile_records(tab_body, unluac_jar, root, "tabs")
        operator_ids = {
            int(record["m_ContractID"])
            for record in contracts
            if record.get("m_NKM_UNIT_TYPE") == "NUT_OPERATOR" and record.get("m_ContractID") is not None
        }
        targets = {
            int(record["m_ContractID"])
            for record in tabs
            if record.get("m_ContractCategory") == 50 and int(record.get("m_ContractID") or 0) in operator_ids
        }
        if not targets:
            raise ValueError("Operator contract category patch found no category-50 operator contracts")

        source = root / "tabs.luac"
        listing = root / "tabs.disassembly"
        patched = root / "tabs-patched.luac"
        run_unluac(unluac_jar, ["--disassemble", "--output", str(listing), str(source)])
        lines = listing.read_text(encoding="utf-8").splitlines()
        category_constant = next(
            (
                match.group(1)
                for line in lines
                if (match := re.match(r'^\s*\.constant\s+(k\d+)\s+"m_ContractCategory"\s*$', line))
            ),
            "",
        )
        contract_id_constant = next(
            (
                match.group(1)
                for line in lines
                if (match := re.match(r'^\s*\.constant\s+(k\d+)\s+"m_ContractID"\s*$', line))
            ),
            "",
        )
        if not category_constant or not contract_id_constant:
            raise ValueError("Operator contract table field constants are missing")

        patched_ids: set[int] = set()
        for index, line in enumerate(lines):
            id_match = re.match(r"^\s*loadi\s+(r\d+)\s+(\d+)\s*$", line)
            if not id_match or int(id_match.group(2)) not in targets:
                continue
            value_register = id_match.group(1)
            field_match = re.match(
                rf"^\s*setfield\s+(r\d+)\s+{re.escape(contract_id_constant)}\s+{re.escape(value_register)}(?:\s*;.*)?$",
                lines[index + 1] if index + 1 < len(lines) else "",
            )
            if not field_match:
                continue
            record_register = field_match.group(1)
            for category_index in range(index + 2, min(len(lines), index + 30)):
                category_match = re.match(
                    rf"^\s*setfield\s+{re.escape(record_register)}\s+{re.escape(category_constant)}\s+(r\d+)(?:\s*;.*)?$",
                    lines[category_index],
                )
                if not category_match:
                    continue
                category_register = category_match.group(1)
                load_index = category_index - 1
                if not re.match(rf"^\s*loadi\s+{re.escape(category_register)}\s+50\s*$", lines[load_index]):
                    raise ValueError(f"Operator contract {id_match.group(2)} category is not loaded as 50")
                lines[load_index] = f"loadi        {category_register}   300"
                patched_ids.add(int(id_match.group(2)))
                break

        if patched_ids != targets:
            raise ValueError(f"Operator category patch coverage mismatch: expected={sorted(targets)} patched={sorted(patched_ids)}")
        listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
        run_unluac(unluac_jar, ["--assemble", "--output", str(patched), str(listing)])
        patched_records = decompile_records(patched.read_bytes(), unluac_jar, root, "tabs-verified")
        verified = {
            int(record["m_ContractID"])
            for record in patched_records
            if int(record.get("m_ContractID") or 0) in targets and record.get("m_ContractCategory") == 300
        }
        if verified != targets:
            raise ValueError(f"Operator category verification mismatch: expected={sorted(targets)} verified={sorted(verified)}")
        return patched.read_bytes()


def decrypt_bundle_header(path: Path) -> bytes:
    data = bytearray(path.read_bytes())
    digest = hashlib.md5(path.stem.lower().encode("utf-8")).hexdigest()
    masks = (
        int(digest[0:16], 16),
        int(digest[16:32], 16),
        int(digest[0:8] + digest[16:24], 16),
        int(digest[8:16] + digest[24:32], 16),
    )
    offset = 0
    mask_index = 0
    limit = min(len(data), HEADER_SIZE)
    while offset < limit:
        mask = masks[mask_index]
        remaining = limit - offset
        if remaining >= 8:
            value = int.from_bytes(data[offset : offset + 8], "little") ^ mask
            data[offset : offset + 8] = value.to_bytes(8, "little")
            offset += 8
        else:
            for index in range(offset, limit):
                data[index] ^= mask & 0xFF
            offset = limit
        mask_index = (mask_index + 1) % len(masks)
    return bytes(data)


def read_text_asset(raw: bytes) -> tuple[str, bytes]:
    if len(raw) < 8:
        raise ValueError("TextAsset serialization is truncated")
    name_size = struct.unpack_from("<i", raw, 0)[0]
    name_end = 4 + name_size
    script_offset = (name_end + 3) & ~3
    if name_size <= 0 or script_offset + 4 > len(raw):
        raise ValueError("TextAsset name is invalid")
    name = raw[4:name_end].decode("utf-8")
    script_size = struct.unpack_from("<i", raw, script_offset)[0]
    script_start = script_offset + 4
    script_end = script_start + script_size
    if script_size < 0 or script_end > len(raw):
        raise ValueError(f"TextAsset script is invalid: {name}")
    return name, raw[script_start:script_end]


def iter_cache_records(bundle_path: Path):
    if UnityPy is None:
        raise RuntimeError("UnityPy is required for Android bundle inputs: py -m pip install UnityPy==1.25.0")
    bundle_name = bundle_path.name.upper()
    environment = UnityPy.load(decrypt_bundle_header(bundle_path))
    for obj in environment.objects:
        if obj.type.name != "TextAsset":
            continue
        name, body = read_text_asset(obj.get_raw_data())
        if not name.lower().endswith("_c"):
            raise ValueError(f"Unexpected compiled Lua asset name in {bundle_path.name}: {name}")
        file_name = f"{name[:-2].upper()}_C.bytes"
        if "/" in file_name or "\\" in file_name:
            raise ValueError(f"Unsafe compiled Lua asset name: {name}")
        plain_name = decrypted_lua_name(name)
        if plain_name.lower().endswith("_c"):
            plain_name = plain_name[:-2]
        yield f"{bundle_name}/{file_name}", body, f"{bundle_name}/{plain_name.upper()}.luac"


def iter_cache_files(bundle_path: Path):
    for relative_path, body, _ in iter_cache_records(bundle_path):
        yield relative_path, body


def gameplay_tables(root: Path) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for source in ("StreamingAssets", "Assetbundles"):
        source_root = root / source
        if not source_root.is_dir():
            continue
        for file_path in sorted(source_root.glob("*/luac/*.luac")):
            logical_path = f"{file_path.parents[1].name.upper()}/{file_path.stem.upper()}.luac"
            result[logical_path.lower()] = file_path
    return result


def overlay_tables(root: Path) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for file_path in sorted(root.glob("Assetbundles/*/luac/*.luac")):
        logical_path = f"{file_path.parents[1].name.upper()}/{file_path.stem.upper()}.luac"
        result[logical_path.lower()] = file_path
    return result


def encrypted_cache_path(logical_path: str) -> str:
    bundle_name, file_name = logical_path.split("/", 1)
    plain_name = Path(file_name).stem
    return f"{bundle_name.upper()}/{encrypted_lua_name(plain_name).upper()}.bytes"


def encode_patch_value(value) -> bytes:
    if isinstance(value, str):
        body = value.encode("utf-8")
        if len(body) > 255:
            raise ValueError(f"PatchInfo string is too long: {value}")
        return bytes((3, len(body))) + body
    if isinstance(value, list):
        return bytes((1,)) + struct.pack("<I", len(value)) + b"".join(encode_patch_value(item) for item in value)
    if isinstance(value, dict):
        return bytes((2,)) + struct.pack("<I", len(value)) + b"".join(
            bytes((len(key.encode("utf-8")),)) + key.encode("utf-8") + encode_patch_value(item)
            for key, item in value.items()
        )
    raise TypeError(value)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--patch-version", required=True, help="ANDROID_N version used to derive ExtraAsset_N")
    parser.add_argument("--output-zip", required=True, type=Path)
    parser.add_argument("--output-manifest", required=True, type=Path)
    parser.add_argument("--output-host-root", type=Path, help="Also materialize patchfiles/ExtraAsset for static hosting")
    parser.add_argument("--gameplay-tables", type=Path, help="PC gameplay-tables root used to fill Android catalog gaps")
    parser.add_argument("--mod-tables", action="append", default=[], type=Path, help="Effective Mod:Side runtime root overlaid onto the cache")
    parser.add_argument("--unluac-jar", type=Path, default=Path(__file__).with_name("unluac.jar"))
    parser.add_argument("bundles", nargs="*", type=Path)
    args = parser.parse_args()
    if not args.patch_version.startswith("ANDROID_") or not args.patch_version[8:].isdigit():
        parser.error("--patch-version must be ANDROID_N")

    version = f"ExtraAsset_{args.patch_version[8:]}"
    if not args.bundles and not args.gameplay_tables:
        parser.error("provide Android script bundles and/or --gameplay-tables")

    records: dict[str, tuple[bytes, str, str]] = {}
    for bundle in args.bundles:
        if not bundle.is_file():
            raise FileNotFoundError(bundle)
        for relative_path, body, logical_path in iter_cache_records(bundle):
            key = relative_path.lower()
            if key in records:
                raise ValueError(f"Duplicate cache path: {relative_path}")
            records[key] = (body, relative_path, logical_path)

    if args.gameplay_tables:
        if not args.gameplay_tables.is_dir():
            raise FileNotFoundError(args.gameplay_tables)
        for logical_key, file_path in gameplay_tables(args.gameplay_tables).items():
            logical_path = logical_key.upper()
            relative_path = encrypted_cache_path(logical_path)
            records[relative_path.lower()] = (crypto2_encrypt(file_path.read_bytes()), relative_path, logical_path)

    for mod_root in args.mod_tables:
        if not mod_root.is_dir():
            raise FileNotFoundError(mod_root)
        for logical_key, file_path in overlay_tables(mod_root).items():
            logical_path = logical_key.upper()
            relative_path = encrypted_cache_path(logical_path)
            records[relative_path.lower()] = (crypto2_encrypt(file_path.read_bytes()), relative_path, logical_path)

    applied_patches: list[str] = []
    counter_pass_key = encrypted_cache_path(COUNTER_PASS_TABLE).lower()
    if counter_pass_key in records:
        encrypted_body, relative_path, logical_path = records[counter_pass_key]
        patched_body = patch_counter_pass_unlock(crypto2_decrypt(encrypted_body), args.unluac_jar.resolve())
        records[counter_pass_key] = (crypto2_encrypt(patched_body), relative_path, logical_path)
        applied_patches.append(COUNTER_PASS_PATCH)

    operator_contract_key = encrypted_cache_path(OPERATOR_CONTRACT_TABLE).lower()
    operator_tab_key = encrypted_cache_path(OPERATOR_TAB_TABLE).lower()
    if operator_contract_key in records and operator_tab_key in records:
        contract_body = crypto2_decrypt(records[operator_contract_key][0])
        encrypted_body, relative_path, logical_path = records[operator_tab_key]
        patched_body = patch_operator_contract_categories(
            contract_body,
            crypto2_decrypt(encrypted_body),
            args.unluac_jar.resolve(),
        )
        records[operator_tab_key] = (crypto2_encrypt(patched_body), relative_path, logical_path)
        applied_patches.append(OPERATOR_CATEGORY_PATCH)

    files: list[dict[str, object]] = []
    total_bytes = 0
    host_version_root = None
    if args.output_host_root:
        extra_asset_root = args.output_host_root.resolve() / "patchfiles" / "ExtraAsset"
        host_version_root = extra_asset_root / version
        if extra_asset_root not in host_version_root.parents:
            raise ValueError(f"Unsafe ExtraAsset host path: {host_version_root}")
        shutil.rmtree(host_version_root, ignore_errors=True)
        host_version_root.mkdir(parents=True, exist_ok=True)
    args.output_zip.parent.mkdir(parents=True, exist_ok=True)
    args.output_manifest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output_zip, "w", compression=zipfile.ZIP_STORED) as archive:
        for _, (body, relative_path, logical_path) in sorted(records.items()):
            if len(relative_path.encode("utf-8")) > 255:
                raise ValueError(f"PatchInfo path is too long: {relative_path}")
            zip_info = zipfile.ZipInfo(relative_path, date_time=(1980, 1, 1, 0, 0, 0))
            zip_info.compress_type = zipfile.ZIP_STORED
            zip_info.external_attr = 0o644 << 16
            archive.writestr(zip_info, body)
            if host_version_root:
                hosted_file = host_version_root.joinpath(*relative_path.split("/"))
                hosted_file.parent.mkdir(parents=True, exist_ok=True)
                hosted_file.write_bytes(body)
            files.append({
                "path": relative_path,
                "logicalPath": logical_path,
                "size": len(body),
                "md5": hashlib.md5(body).hexdigest(),
            })
            total_bytes += len(body)

    files.sort(key=lambda item: str(item["path"]))
    manifest = {
        "schemaVersion": 1,
        "version": version,
        "clientParityPatches": applied_patches,
        "files": files,
    }
    args.output_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if host_version_root:
        extra_asset_root = host_version_root.parent
        (extra_asset_root / "liveVersion.json").write_text(
            json.dumps({"versionList": [{"version": version}]}) + "\n",
            encoding="utf-8",
        )
        (host_version_root / "PatchInfo.json").write_bytes(encode_patch_value({
            "version": version,
            "data": [[item["path"], item["md5"], str(item["size"])] for item in files],
        }))
    print(f"Built {version}: {len(files)} files, {total_bytes} bytes -> {args.output_zip}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
