# RevivalSide Setup Guide

This guide is written for someone who has access to the RevivalSide repo but does not already know software development. Follow it slowly, paste one command at a time, and keep each PowerShell window open until the step says you can close it.

RevivalSide has two things most people want to run:

- **RevivalSide Wiki**: a local website for searching game IDs, units, gear, items, skins, contracts, and images.
- **Server listener**: the local server process the game connects to while you test RevivalSide.

You can set up only the wiki, only the listener, or both. If you want the normal local testing flow, set up both.

## Quick Map

The setup has four big parts:

1. Install the basic tools: Node.js, .NET, and Python.
2. Download or open the repo.
3. Optionally refresh local game data if you are updating tables/assets.
4. Start the wiki and the listener.

The listener, event manager, shop, contract, mission, collection, and stamina systems can read installed `.luac` tables derived from the encrypted CounterSide assets next to `Data\Managed`. You only need part 3 when warming that cache, refreshing maintainer JSON fixtures, or extracting images for the wiki.

## Before You Start

You need:

- Windows 10 or Windows 11.
- CounterSide installed through Steam.
- Access to this repo.
- About 10 GB of free disk space if you are extracting images.
- A little patience during the first asset extraction. It can take a while.

The default CounterSide install path used by this guide is:

```text
C:\Program Files (x86)\Steam\steamapps\common\CounterSide
```

If your game is installed somewhere else, that is fine. You will change one line later.

## Words This Guide Uses

- **Repo** means the RevivalSide folder that has `package.json`, `cs-listener.js`, `tools`, and `docs`.
- **PowerShell** is the blue Windows terminal.
- **Command** means a line you paste into PowerShell and run with Enter.
- **Admin PowerShell** means PowerShell opened with "Run as administrator".
- **Listener** means `npm run listen`.
- **Wiki** means the local website started by `npm run wiki:serve`.

## Install The Tools

Install these first. After installing them, close and reopen PowerShell so Windows can find the new commands.

### 1. Node.js

Install the current **LTS** version from:

```text
https://nodejs.org/
```

Node runs the RevivalSide listener and wiki tools.

### 2. .NET 8 SDK

Install the **.NET 8 SDK** from:

```text
https://dotnet.microsoft.com/download/dotnet/8.0
```

The SDK builds the C# combat host used by the listener.

### 3. Python

Install Python 3.11 or newer from:

```text
https://www.python.org/downloads/
```

During install, turn on the checkbox named **Add python.exe to PATH** if you see it.

### 4. Java

Install Java 17 or newer. Eclipse Temurin is a good choice:

```text
https://adoptium.net/
```

Java is only needed for maintainer workflows that explicitly run `unluac` to refresh parsed table source. Normal listener startup does not use it.

### Optional: Git

Git is only needed if you want to clone or update the repo with `git pull`.

Install it from:

```text
https://git-scm.com/download/win
```

If you do not want to install Git, download the repo as a ZIP from GitHub and extract it instead.

### Check That The Tools Work

Open normal PowerShell and run:

```powershell
node -v
npm -v
dotnet --version
py --version
java -version
```

You do not need the exact same versions as another person. You just want every command to print a version instead of an error like "not recognized".

If `py --version` fails but `python --version` works, use `python` anywhere this guide says `py`.

If you installed Git, also run:

```powershell
git --version
```

If `git --version` works, you can use the Git clone steps below. If it does not, use the ZIP download path.

## Open The Repo Folder

If you already have the repo folder, open it in File Explorer. Click the address bar, type `powershell`, then press Enter. PowerShell should open directly in that folder.

If you need to clone the repo with Git:

```powershell
cd "$env:USERPROFILE\Desktop"
git clone --recurse-submodules https://github.com/MadlyMoe/RevivalSide.git RevivalSide
cd RevivalSide
```

If you already cloned the repository and intend to build the desktop launcher, initialize its shared source repository once:

```powershell
git submodule update --init --recursive
```

GitHub's automatically generated source ZIP does not include the contents of Git submodules. Use Git for launcher development, or use the packaged RevivalSide release if you only want to run the launcher.

If you downloaded a ZIP instead, extract it, open the extracted `RevivalSide` folder, click the address bar, type `powershell`, and press Enter.

To confirm you are in the right folder:

```powershell
dir
```

You should see files like:

```text
package.json
cs-listener.js
tools
docs
```

## First-Time Repo Setup

Run these commands from the repo folder:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm install
npm run build:combat-host
```

What these do:

- `.env` is your local settings file.
- `npm install` downloads the JavaScript packages.
- `npm run build:combat-host` builds the C# combat host.

If your CounterSide install is not in the default Steam folder, open `.env` in Notepad:

```powershell
notepad .env
```

Find this line:

```text
CS_COUNTERSIDE_MANAGED_DIR=C:\Program Files (x86)\Steam\steamapps\common\CounterSide\Data\Managed
```

Change it to your real `Data\Managed` folder. The folder must contain `Assembly-CSharp.dll`.

## Refresh Local Game Data

The repo does not store raw game assets, raw DLLs, your account data, decrypted Lua bytecode, or decompiled Lua intermediates. Runtime table reads can use installed `.luac` assets, so run this section only when warming the local gameplay cache, rebuilding optional maintainer JSON fixtures, or extracting images.

Set a short variable for your CounterSide folder:

```powershell
$client = "C:\Program Files (x86)\Steam\steamapps\common\CounterSide"
```

If your game is installed somewhere else, change the path inside the quotes.

### Install Python Packages

Run:

```powershell
py -m pip install UnityPy pillow
```

If `py` does not work on your machine, run:

```powershell
python -m pip install UnityPy pillow
```

### Build The Installed-Client Gameplay Cache

Run:

```powershell
npm run ensure:gameplay-assets
```

This starts from `CS_COUNTERSIDE_MANAGED_DIR` or the auto-detected Steam install, walks from `Data\Managed` to the installed encrypted `Data\StreamingAssets\ab_script*` bundles, and writes decrypted Lua bytecode to `.cache\gameplay-luac`. It does not run `unluac` or rebuild parsed/decompiled table dumps.

### Rebuild Optional Gameplay JSON Fixtures

This is only needed when deliberately refreshing legacy parsed JSON fixtures from a prepared parsed JSON root. Normal listener startup does not do this.

Run:

```powershell
npm run build:gameplay-jsons
```

If you use this maintainer workflow, set `CS_GAMEPLAY_BUILD_SOURCE_ROOTS` or keep a legacy `gameplay-tables-json` parsed root available first.

### Build The Server Data Indexes

Run:

```powershell
py .\tools\cs_build_server_data.py --parsed-root .\gameplay-jsons\StreamingAssets --out-dir .\server-data
```

This creates compact server files like `server-data\units.json`.

### Optional: Extract Images For The Wiki

The wiki works without images, but it is much nicer with PNGs.

First decrypt asset bundle headers:

```powershell
py .\tools\cs_asset_decrypt.py decrypt-header --all-assets --root "$client\Data\StreamingAssets" --out-dir .\extracted-assets\decrypted --overwrite
```

Then extract readable assets:

```powershell
py .\tools\cs_extract_decrypted_assets.py --root .\extracted-assets\decrypted --out-dir .\extracted-assets\all --manifest .\extracted-assets\manifest.json --overwrite-manifest
```

This can take a while. If you only care about IDs and text data, you can skip image extraction.

## Start The Wiki

From the repo folder, build the wiki data:

```powershell
npm run wiki:build
```

Then start the local wiki website:

```powershell
npm run wiki:serve
```

PowerShell should print something like:

```text
RevivalSide Wiki running at http://127.0.0.1:5174/
```

Open that address in your browser. If port `5174` is busy, the script will try the next port, like `5175`.

Keep that PowerShell window open while you use the wiki. Close the window when you want to stop the wiki.

## Start The Server Listener

The listener is what the game connects to. It uses:

- TCP `127.0.0.1:22000` for game traffic.
- HTTP mirror `http://127.0.0.1:8088` for captured boot/config responses.

### Freeze And Route A Local CounterSide Client

Open **Game Settings**, use **Detect CounterSide** or **Browse DLL** to select an official installation's `Data\Managed\Assembly-CSharp.dll`, then choose **Freeze Selected Client**. The launcher creates the isolated copy under `%LOCALAPPDATA%\RevivalSide\frozen-client`; the source installation is left untouched.

When the listener starts, the launcher patches every external HTTP endpoint in that isolated client to the launcher's local ServerInfo URL. It also removes `steam_appid.txt`, quarantines native `steam_api` DLLs, disables the managed Steam runtime, and refuses to continue unless the audit reports zero Steamworks callsites and zero remaining external endpoints. The client then launches directly without starting or requiring Steam.

RevivalSide preserves the frozen copy's own gameplay tables and advertises the content version from the same source priority the game uses: downloaded `Assetbundles` first, then base `StreamingAssets`. The patch leaves the client's normal content-version validation untouched while routing official URLs to the local listener, preventing official patch downloads, and removing the Steam runtime dependency. These changes replace the old Windows hosts-file patch and do not require an administrator prompt.

Use **START** for the RevivalSide copy. Keep any Steam-managed installation separate if you still need the normal official client.

If you are upgrading from a release that used the old hosts patch, run this one-time cleanup from an elevated PowerShell prompt:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\remove-legacy-hosts-patch.ps1
```

### Run The Listener

The recommended path is the launcher's **START** button after a client has been frozen; it patches the copy and starts the listener. For server-only debugging, open a normal PowerShell window in the repo folder and run:

```powershell
npm run listen
```

Good startup signs:

```text
[+] Listening on port 22000
[+] Captured HTTP mirror listening on http://127.0.0.1:8088
[+] User manager listening on http://127.0.0.1:8088/user-manager
```

Keep this PowerShell window open. This window is now the local server log. The command does not patch or launch the client.

### Edit Local User Profiles

While the listener is running, open:

```text
http://127.0.0.1:8088/user-manager
```

This page edits the local `server-data\users.json` file used by the listener. It can create, clone, delete, repair, and fully edit profile JSON. Each save keeps a backup in `server-data\users.backups`.

### Start CounterSide

Start CounterSide after the listener is already running.

If the game reaches the local flow, you should see activity in the listener window. If the listener window stays completely silent, the game is probably not reaching your local listener.

## Stop Everything

To stop the wiki or listener, click the PowerShell window and press:

```text
Ctrl+C
```

Stopping RevivalSide does not require undoing a system-wide routing change. The launcher patches only the selected frozen client's assembly.

## Everyday Startup

After the first setup is done, most days are much shorter.

### Wiki

```powershell
npm run wiki:build
npm run wiki:serve
```

### Listener

```powershell
npm run listen
```

Press **START** in RevivalSide so the frozen client's patched local routing is used.

## Updating Later

If you cloned with Git:

```powershell
git pull
npm install
npm run build:combat-host
npm run wiki:build
```

If game data changed after a CounterSide update, rebuild the local game data section too.

## Common Problems

### `node` or `npm` is not recognized

Install Node.js LTS, then close and reopen PowerShell.

### `dotnet` is not recognized

Install the .NET 8 SDK, not only the runtime. Then close and reopen PowerShell.

### `py` is not recognized

Try `python --version`. If that works, use `python` instead of `py`. If neither works, reinstall Python and enable "Add python.exe to PATH".

### Java errors during decompile

Run `java -version`. If it fails, install Java 17 or newer and reopen PowerShell.

### `Assembly-CSharp.dll` cannot be found

Open `.env` and fix:

```text
CS_COUNTERSIDE_MANAGED_DIR=...
```

It must point to the `Data\Managed` folder inside CounterSide.

### The wiki opens but has no images

The image extraction step was skipped or failed. Run the optional image extraction commands, then run:

```powershell
npm run wiki:build
npm run wiki:serve
```

### The wiki command says no table files exist

Run `npm run build:gameplay-jsons` if you are refreshing tables. The wiki reads table data from `gameplay-jsons`; images still require the optional asset extraction step.

### The listener starts, but the game does not connect

Check these:

- The listener is still running.
- The RevivalSide client is installed and the launcher patch completed successfully.
- `.env` still has `CS_PORT=22000`.
- No other program is using port `22000`.
- CounterSide was launched with **START** after patching.

### The RevivalSide client opens Steam

Do not open the original Steam shortcut. Use **START** in the current RevivalSide launcher. Before every launch it reapplies the managed isolation patch, removes `steam_appid.txt`, quarantines active `steam_api` DLLs inside the frozen copy, and launches `CounterSide.exe` directly with Steam environment variables removed.

### The RevivalSide client requests a large update

Stop the client instead of accepting the download, then update and restart the RevivalSide launcher. The listener must log the frozen build, for example `frozenClientUpdate=STANDALONE_WINDOWS_335238 frozen=yes required=on`. The mirror now advertises the selected archive's own version and serves its own installed `PatchInfo.json`; it does not use the newer build number from the captured HTTP fixture.

### The normal official game no longer loads

Launch the Steam-managed installation instead of the frozen RevivalSide copy. RevivalSide no longer changes the Windows hosts file, so there is no system-wide routing change to undo.

### Port `8088` or `22000` is already in use

Close old listener windows first. If that does not work, restart your computer or change the ports in `.env`.

### `npm install` fails

Check your internet connection and Node.js install. Then run:

```powershell
npm install
```

again from the repo folder.

## What Not To Commit

Do not commit local generated data from your own client unless the project owner specifically asks for a sanitized fixture update. The exception is `gameplay-jsons`, which is the tracked parsed gameplay table source.

Keep these local:

- `Assembly-CSharp`
- `.cache`
- legacy `gameplay-tables*` folders if you still create them manually
- `extracted-assets`
- raw packet captures
- account state or personal game data

The repo already has README files in those folders explaining what belongs there.

## Useful Links Inside The Repo

- `docs\dump-assembly-csharp.md`: notes for ILSpy and dnSpyEx.
- `docs\captures.md`: packet capture and fixture notes.
- `server-data\README.md`: what generated server data means.
- `combat-host\README.md`: how the C# combat host fits into the listener.
