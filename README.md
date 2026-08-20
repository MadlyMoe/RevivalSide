# RevivalSide

RevivalSide is a local CounterSide revival research server. It includes the Node.js TCP listener, packet handlers, capture tooling, a C# combat-host bridge, and project-built combat-host binaries.

This repository intentionally does not track client assets, raw packet captures, decompiled `Assembly-CSharp` source dumps, decrypted Lua bytecode, account databases, or raw game DLLs. Runtime gameplay tables can be loaded from the encrypted CounterSide install by deriving the script assets from the selected `Data\Managed` directory.

## What Is Tracked

- `cs-listener.js`: TCP listener, packet framing, HTTP mirror, login/session glue.
- `packet-handlers/`: request handlers for login, lobby, battle, cutscene, and utility packets.
- `combat-handler/`: Node-side combat session orchestration and bridge into the C# host.
- `combat-host/`: C# local combat host and managed assembly patcher.
- `prebuilt/combat-host/`: published RevivalSide combat host binaries.
- `tools/`: capture, table extraction, packet schema, and setup helper scripts.
- `launcher/`: a pinned Git submodule of the shared [timeworn/revivalside-launcher](https://github.com/timeworn/revivalside-launcher) React/Tauri UI, wired to the full local runtime.
- `gameplay-jsons/`: optional legacy parsed gameplay table fixtures. Normal listener runtime can use installed `.luac` assets instead.
- `stages/`: hand-authored stage definitions used by current tutorial work.
- `server-data/captured-*`: sanitized HTTP, login/content, and tutorial game-stream fixtures.
- `packet-schema.json`: generated protocol reference used for packet work.

## Quick Start

Start with [docs/setup.md](docs/setup.md). It is written for first-time users and walks through the wiki, freezing a local CounterSide client, local routing, and the listener without assuming software development experience.

The very short setup is:

```powershell
git clone --recurse-submodules https://github.com/MadlyMoe/RevivalSide.git RevivalSide
cd RevivalSide
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm install
npm run build:combat-host
```

Fresh local accounts and runtime features can use `.luac` tables cached from the encrypted assets next to `Data\Managed`, without requiring raw/decompiled table dumps or `gameplay-jsons`.

To run the local wiki:

```powershell
npm run wiki:build
npm run wiki:serve
```

Mod:Side is a separate React service, like the wiki. Build it once after frontend changes, then start it without the game listener:

```powershell
npm run build:modside
npm run modside
```

Open `http://127.0.0.1:5175/mod-side`.

The standalone Combat Simulator is separate from the wiki. It discovers the installed CounterSide `Data\Managed` directory, runs stages through the real `NKCGameServerLocal`, records every managed frame, and renders extracted stage and unit Spine assets in WebGL:

```powershell
npm run combat-simulator
```

Open `http://127.0.0.1:5185/`. **Live CounterSide stage** uses the game's stage, dungeon, event-deck, unit, skill, AI, targeting, damage, summon, and win-state logic. **Editable stat sandbox** remains available for arbitrary raw HP/damage/range experiments that are not legal CounterSide deck inputs. Client DLLs and extracted art remain local and are not distributed by this repository.

To run the server listener directly:

```powershell
npm run listen
```

The desktop launcher freezes a separately installed official client selected in Game Settings. It patches and audits the isolated copy so its official HTTP endpoints route directly to the local listener. It removes the copy's Steam app-ID trigger, quarantines native Steam API DLLs, strips Steam launch variables, and refuses to launch until the managed client has zero remaining Steamworks callsites. The local mirror advertises that copy's installed patch and content versions, preferring downloaded `Assetbundles` over base `StreamingAssets`, and serves its installed `PatchInfo.json`. This prevents large patch downloads without overriding the client's normal content-version validation. RevivalSide does not modify the Windows hosts file. Running `npm run listen` by itself starts only the server; use the launcher to freeze, prepare, and launch the client.

The default listener uses TCP `127.0.0.1:22000` and HTTP mirror `http://127.0.0.1:8088`.
Private PvP is available through the stock in-game room UI and is hosted authoritatively by one player's CombatHost. Use [Host A Private PvP Match](docs/setup.md#host-a-private-pvp-match) for LAN/Tailscale play or the launcher's [one-click encrypted internet relay](docs/relay-server.md) so neither player exposes home listener ports.
The local user profile manager is served from the same process at `http://127.0.0.1:8088/user-manager`. Profile selection and switching use lightweight summaries plus `server-data/active-user.json`; full profile or database JSON is loaded only when you click the corresponding **Load JSON** button.
Mod:Side is available at `http://127.0.0.1:5175/mod-side` and runs independently of the listener. Its React dashboard links to Asset:Side, Story:Side, Unit:Side, and Combat:Side while reusing the existing protected game-data and mod APIs. Asset:Side groups Game systems, Game objects, Gameplay tables, and Extracted assets for human-readable inspection while keeping base files protected. Game objects lists every unit, ship, operator, and gear with its related IDs, exact source fields, plain-English uses, unit art assignments, and gear `gear_stat_ids` min/max ranges. Its asset editor writes PNG, audio, Spine, and other supported replacements into a mod project, preserves the original asset name and AssetBundle, validates PNG dimensions, builds Windows bundles through Unity 2022.3.62f2 when available, and imports or exports editable `.revivalmod.zip` projects. The Mod creator writes portable projects under `mods/` with `mod.json`, `mod.lock.json`, per-record patches, assets, validation reports, and ZIP import/export. The Mod loader installs ZIP/`.revivalmod` projects directly and atomically activates or deactivates them; failed builds keep the previous profile and runtime. Restart the listener and frozen client after changing the runtime; the launcher patches the client Lua loader and passes the active runtime directory automatically.
Unit Maker accepts separate Management/gacha, SD/chibi, and live-battle Spine sets. Export each as one binary Spine 3.7.x `.skel`, one `.atlas`, and every PNG page named by the atlas; the selected base unit supplies the compatible CounterSide prefab and therefore the animation, bone, slot, and event contract. Create the unit with the files selected, or use **Attach / retry selected Spine sets** afterward. The generated mod ZIP contains both the editable source set and the ready-to-load client bundles; no Unity installation is required for this Spine path.
Spine previews use the production build in `SpineViewer/dist`; set `CS_SPINE_VIEWER_DIST` when the separate [MadlyMoe/SpineViewer](https://github.com/MadlyMoe/SpineViewer) checkout lives elsewhere.

### Launcher development

The production launcher is the Tauri app pinned in the `launcher/` submodule. It keeps the existing `launcher-settings.json` format and delegates RevivalSide-specific operations to `tools/revivalside-launcher-backend.js`, so packaged and source checkouts use the same listener, client patcher, cache, wiki, and Cross Save tooling. Launcher changes are proposed to the shared launcher repository; this repository advances its submodule commit after those changes are accepted.

For an existing clone, initialize or refresh the submodule, then install Node.js plus the Rust MSVC toolchain and run:

```powershell
git submodule update --init --recursive
npm run check:launcher
npm run build:launcher
```

People using the packaged v0.3.5 installer do not need Node.js, pnpm, or Rust. Those tools are only required to build the launcher from source.
