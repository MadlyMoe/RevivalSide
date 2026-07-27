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

Start with [docs/setup.md](docs/setup.md). It is written for first-time users and walks through the wiki, the downloadable RevivalSide client, local routing, and the listener without assuming software development experience.

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

To run the server listener directly:

```powershell
npm run listen
```

The desktop launcher downloads the non-commercial RevivalSide client from the public [RevivalSide-Client releases](https://github.com/MadlyMoe/RevivalSide-Client/releases) when it is missing, verifies every release chunk and the reconstructed archive, then patches and audits that isolated copy so its official HTTP endpoints route directly to the local listener. It removes the copy's Steam app-ID trigger, quarantines native Steam API DLLs, strips Steam launch variables, and refuses to launch until the managed client has zero remaining Steamworks callsites. The local mirror advertises that copy's own installed build and serves its installed `PatchInfo.json`, preventing captured newer metadata from triggering an update. RevivalSide does not modify the Windows hosts file. Running `npm run listen` by itself starts only the server; use the launcher to download, prepare, and launch the client.

The default listener uses TCP `127.0.0.1:22000` and HTTP mirror `http://127.0.0.1:8088`.
The local user profile manager is served from the same process at `http://127.0.0.1:8088/user-manager`. Profile selection and switching use lightweight summaries plus `server-data/active-user.json`; full profile or database JSON is loaded only when you click the corresponding **Load JSON** button.

### Launcher development

The production launcher is the Tauri app pinned in the `launcher/` submodule. It keeps the existing `launcher-settings.json` format and delegates RevivalSide-specific operations to `tools/revivalside-launcher-backend.js`, so packaged and source checkouts use the same listener, client patcher, cache, wiki, and Cross Save tooling. Launcher changes are proposed to the shared launcher repository; this repository advances its submodule commit after those changes are accepted.

For an existing clone, initialize or refresh the submodule, then install Node.js plus the Rust MSVC toolchain and run:

```powershell
git submodule update --init --recursive
npm run check:launcher
npm run build:launcher
```

People using the packaged v0.3.5 installer do not need Node.js, pnpm, or Rust. Those tools are only required to build the launcher from source.
