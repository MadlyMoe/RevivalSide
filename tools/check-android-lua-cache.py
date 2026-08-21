#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from cs_asset_decrypt import crypto2_decrypt
from cs_lua_table_pipeline import parse_lua_table


COUNTER_PASS_TABLE = "ab_script/lua_contents_unlock_templet.luac"
COUNTER_PASS_PATCH = "counter-pass-always-unlocked"
OPERATOR_CONTRACT_TABLE = "ab_script/lua_contract.luac"
OPERATOR_TAB_TABLE = "ab_script/lua_contract_tab_table.luac"
OPERATOR_CATEGORY_PATCH = "operator-contract-category"


def counter_pass_unlock_type(body: bytes, unluac_jar: Path) -> str:
    with tempfile.TemporaryDirectory(prefix="revivalside-counter-pass-check-") as temporary:
        source = Path(temporary) / "table.luac"
        decompiled = Path(temporary) / "table.lua"
        source.write_bytes(body)
        result = subprocess.run(
            ["java", "-jar", str(unluac_jar), "--output", str(decompiled), str(source)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, (result.stderr or result.stdout).strip()
        matches = [
            record for record in parse_lua_table(decompiled)["records"]
            if record.get("eContentsType") == "COUNTER_PASS"
        ]
        assert len(matches) == 1, f"Expected one Counter Pass record, found {len(matches)}"
        return str(matches[0].get("m_UnlockReqType") or "")


def lua_records(body: bytes, unluac_jar: Path, prefix: str) -> list[dict[str, object]]:
    with tempfile.TemporaryDirectory(prefix=prefix) as temporary:
        source = Path(temporary) / "table.luac"
        decompiled = Path(temporary) / "table.lua"
        source.write_bytes(body)
        result = subprocess.run(
            ["java", "-jar", str(unluac_jar), "--output", str(decompiled), str(source)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, (result.stderr or result.stdout).strip()
        return list(parse_lua_table(decompiled)["records"])


def effective_lua_tables(gameplay_root: Path, mod_roots: list[Path]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for source in ("StreamingAssets", "Assetbundles"):
        source_root = gameplay_root / source
        if not source_root.is_dir():
            continue
        for file_path in sorted(source_root.glob("*/luac/*.luac")):
            logical_path = f"{file_path.parents[1].name.upper()}/{file_path.name}".lower()
            result[logical_path] = file_path
    for mod_root in mod_roots:
        source_root = mod_root / "Assetbundles"
        if not source_root.is_dir():
            continue
        for file_path in sorted(source_root.glob("*/luac/*.luac")):
            logical_path = f"{file_path.parents[1].name.upper()}/{file_path.name}".lower()
            result[logical_path] = file_path
    return result


def verify_cache(archive_path: Path, manifest_path: Path, gameplay_root: Path, mod_roots: list[Path]) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert COUNTER_PASS_PATCH in manifest.get("clientParityPatches", []), "Android cache omitted the Counter Pass client parity patch"
    assert OPERATOR_CATEGORY_PATCH in manifest.get("clientParityPatches", []), "Android cache omitted the operator contract category patch"
    records = {str(record["logicalPath"]).lower(): record for record in manifest["files"]}
    expected = effective_lua_tables(gameplay_root, mod_roots)
    missing = sorted(set(expected) - set(records))
    assert not missing, f"Android cache is missing PC Lua: {missing[:20]}"
    mismatched: list[str] = []
    unluac_jar = Path(__file__).with_name("unluac.jar")
    contract_records = lua_records(expected[OPERATOR_CONTRACT_TABLE].read_bytes(), unluac_jar, "revivalside-operator-contract-check-")
    operator_ids = {
        int(record["m_ContractID"])
        for record in contract_records
        if record.get("m_NKM_UNIT_TYPE") == "NUT_OPERATOR" and record.get("m_ContractID") is not None
    }
    with zipfile.ZipFile(archive_path) as archive:
        for logical_path, source_path in expected.items():
            record = records[logical_path]
            cached = crypto2_decrypt(archive.read(record["path"]))
            source = source_path.read_bytes()
            if logical_path == COUNTER_PASS_TABLE:
                assert counter_pass_unlock_type(source, unluac_jar) == "SURT_CLEAR_DUNGEON"
                assert counter_pass_unlock_type(cached, unluac_jar) == "SURT_ALWAYS_UNLOCKED"
                continue
            if logical_path == OPERATOR_TAB_TABLE:
                source_rows = lua_records(source, unluac_jar, "revivalside-operator-tab-source-")
                cached_rows = lua_records(cached, unluac_jar, "revivalside-operator-tab-cache-")
                assert len(source_rows) == len(cached_rows)
                source_by_id = {int(row["m_ContractID"]): row for row in source_rows}
                cached_by_id = {int(row["m_ContractID"]): row for row in cached_rows}
                targets = {
                    contract_id
                    for contract_id, row in source_by_id.items()
                    if contract_id in operator_ids and row.get("m_ContractCategory") == 50
                }
                assert targets, "PC tables contain no category-50 operator contracts"
                for contract_id, source_row in source_by_id.items():
                    expected_row = dict(source_row)
                    if contract_id in targets:
                        expected_row["m_ContractCategory"] = 300
                    assert cached_by_id.get(contract_id) == expected_row, f"Operator tab parity mismatch for contract {contract_id}"
                continue
            if cached != source:
                mismatched.append(
                    f"{logical_path} android={hashlib.sha256(cached).hexdigest()[:12]} "
                    f"pc={hashlib.sha256(source).hexdigest()[:12]}"
                )
    assert not mismatched, f"Android cache differs from PC Lua: {mismatched[:20]}"
    print(f"[android-lua-cache] PASS PC Lua parity files={len(expected)} plus Counter Pass and operator-category patches archive={archive_path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--gameplay-tables", type=Path)
    parser.add_argument("--mod-tables", action="append", default=[], type=Path)
    args = parser.parse_args()
    if args.archive or args.manifest or args.gameplay_tables:
        if not args.archive or not args.manifest or not args.gameplay_tables:
            parser.error("--archive, --manifest, and --gameplay-tables are required together")
        verify_cache(args.archive, args.manifest, args.gameplay_tables, args.mod_tables)
        return 0

    script = Path(__file__).with_name("build-android-lua-cache.py")
    with tempfile.TemporaryDirectory(prefix="revivalside-lua-cache-") as temporary:
        root = Path(temporary)
        table = root / "gameplay-tables" / "StreamingAssets" / "ab_script" / "luac" / "LUA_TEST.luac"
        table.parent.mkdir(parents=True)
        table.write_bytes(b"compiled-pc-lua")
        counter_pass_source = Path(__file__).parents[1] / "gameplay-tables" / "StreamingAssets" / "ab_script" / "luac" / "LUA_CONTENTS_UNLOCK_TEMPLET.luac"
        assert counter_pass_source.is_file(), counter_pass_source
        counter_pass_table = table.with_name("LUA_CONTENTS_UNLOCK_TEMPLET.luac")
        shutil.copy2(counter_pass_source, counter_pass_table)
        for file_name in ("LUA_CONTRACT.luac", "LUA_CONTRACT_TAB_TABLE.luac"):
            source = counter_pass_source.with_name(file_name)
            assert source.is_file(), source
            shutil.copy2(source, table.with_name(file_name))
        archive = root / "cache.zip"
        manifest_path = root / "cache.json"
        host = root / "host"
        subprocess.run([
            sys.executable, str(script),
            "--patch-version", "ANDROID_335570",
            "--output-zip", str(archive),
            "--output-manifest", str(manifest_path),
            "--output-host-root", str(host),
            "--gameplay-tables", str(root / "gameplay-tables"),
        ], check=True)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert manifest["version"] == "ExtraAsset_335570"
        assert len(manifest["files"]) == 4
        assert manifest["clientParityPatches"] == [COUNTER_PASS_PATCH, OPERATOR_CATEGORY_PATCH]
        record = next(item for item in manifest["files"] if item["logicalPath"] == "AB_SCRIPT/LUA_TEST.LUAC")
        assert record["logicalPath"] == "AB_SCRIPT/LUA_TEST.LUAC"
        with zipfile.ZipFile(archive) as cache:
            assert crypto2_decrypt(cache.read(record["path"])) == table.read_bytes()
        hosted = host / "patchfiles" / "ExtraAsset" / manifest["version"] / record["path"]
        assert hosted.read_bytes()
        assert (host / "patchfiles" / "ExtraAsset" / "liveVersion.json").is_file()
        assert (hosted.parents[1] / "PatchInfo.json").is_file()
        verify_cache(archive, manifest_path, root / "gameplay-tables", [])
    print("[android-lua-cache] PASS PC table encryption, manifest, ZIP, and static host tree")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
