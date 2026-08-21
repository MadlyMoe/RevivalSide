#!/usr/bin/env python3
"""Repair the stock Android lobby's unassigned Counter Pass menu reference."""

from __future__ import annotations

import argparse
from pathlib import Path

from cs_asset_decrypt import load_bundle, transform_bundle_header


LOBBY_CLASS = "NKCUILobbyV2"
PASS_CLASS = "NKCUILobbyMenuEventPass"
LOBBY_PREFAB = "NUF_HOME_PREFAB_RENEWAL"
PASS_OBJECT = "COUNTER_PASS"


def path_id(pointer: object) -> int:
    return int(getattr(pointer, "path_id", getattr(pointer, "m_PathID", 0)) or 0)


def script_class(component: object) -> str:
    try:
        return str(component.m_Script.read().m_ClassName)
    except Exception:
        return ""


def game_object_transform(game_object: object) -> object | None:
    for component in game_object.m_Component:
        try:
            value = component.component.read()
            if value.object_reader.type.name in {"Transform", "RectTransform"}:
                return value
        except Exception:
            continue
    return None


def belongs_to_root(game_object: object, root_path_id: int) -> bool:
    transform = game_object_transform(game_object)
    while transform is not None:
        if path_id(transform.m_GameObject) == root_path_id:
            return True
        parent = transform.m_Father
        transform = parent.read() if path_id(parent) else None
    return False


def inspect_lobby(environment: object) -> tuple[object, object, object]:
    lobbies: list[object] = []
    passes: list[object] = []
    for reader in environment.objects:
        if reader.type.name != "MonoBehaviour":
            continue
        try:
            component = reader.read()
        except Exception:
            continue
        class_name = script_class(component)
        if class_name == LOBBY_CLASS and component.m_GameObject.read().m_Name == LOBBY_PREFAB:
            lobbies.append(component)
        elif class_name == PASS_CLASS:
            passes.append(component)

    if len(lobbies) != 1:
        raise ValueError(f"expected one {LOBBY_CLASS} on {LOBBY_PREFAB}; found {len(lobbies)}")
    lobby = lobbies[0]
    root_path_id = path_id(lobby.m_GameObject)
    candidates = []
    for component in passes:
        game_object = component.m_GameObject.read()
        if (
            game_object.m_Name == PASS_OBJECT
            and belongs_to_root(game_object, root_path_id)
            and path_id(component.m_csbtnMenu)
            and path_id(component.m_objRoot)
            and path_id(component.m_objEmpty)
        ):
            candidates.append(component)
    if len(candidates) != 1:
        raise ValueError(f"expected one wired {PASS_CLASS} below {LOBBY_PREFAB}; found {len(candidates)}")
    counter_pass = candidates[0]
    return lobby, counter_pass, counter_pass.m_GameObject.read()


def verify(bundle: Path) -> tuple[int, int, int]:
    environment = load_bundle(bundle)
    lobby, counter_pass, game_object = inspect_lobby(environment)
    lobby_target = path_id(lobby.m_UIEventPass)
    pass_target = int(counter_pass.object_reader.path_id)
    active = int(game_object.m_IsActive)
    if lobby_target != pass_target:
        raise ValueError(f"lobby Counter Pass reference is {lobby_target}, expected {pass_target}")
    if active != 1:
        raise ValueError("wired Counter Pass GameObject is inactive")
    return lobby_target, pass_target, active


def patch(source: Path, output: Path) -> None:
    if output.name != source.name:
        raise ValueError(f"output must keep encrypted bundle name {source.name}: {output}")

    environment = load_bundle(source)
    lobby, counter_pass, game_object = inspect_lobby(environment)
    lobby.m_UIEventPass.m_FileID = 0
    lobby.m_UIEventPass.m_PathID = int(counter_pass.object_reader.path_id)
    lobby.save()
    game_object.m_IsActive = 1
    game_object.save()

    bundle = next((item for item in environment.files.values() if hasattr(item, "save")), None)
    if bundle is None:
        raise ValueError(f"Unity bundle was not found in {source}")
    packed = bundle.save(packer="original")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(transform_bundle_header(packed, output))
    lobby_target, _, _ = verify(output)
    print(f"[android-counter-pass-ui] patched {output} lobbyTarget={lobby_target} active=1")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source = args.bundle.resolve()
    if args.check:
        lobby_target, _, _ = verify(source)
        print(f"[android-counter-pass-ui] PASS {source} lobbyTarget={lobby_target} active=1")
        return 0
    if args.out is None:
        parser.error("--out is required unless --check is used")
    patch(source, args.out.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
