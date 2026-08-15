# RevivalSide Setup Guide

This guide is written for someone who has access to the RevivalSide repo but does not already know software development. Follow it slowly, paste one command at a time, and keep each terminal window open until the step says you can close it.

RevivalSide has two things most people want to run:

- **RevivalSide Wiki**: a local website for searching game IDs, units, gear, items, skins, contracts, and images.
- **Server listener**: the local server process the game connects to while you test RevivalSide.

You can set up only the wiki, only the listener, or both. If you want the normal local testing flow, set up both.

## Disclaimer

Linux support for RevivalSide is currently in pre-alpha. This means that some features such as UI launcher, have not been tested and are not guaranteed to work correctly, especially on non-Arch-based distros. If you are not ready to deal with technical issues, it's highly recommended staying on the Windows version of RevivalSide. If you encounter any issues, you can report them through the RevivalSide bug report channels.
Instructions will be updated as RevivalSide Linux branch develops.

## Quick Map

The setup has four big parts:

1. Install the basic tools: Node.js, .NET, and Python.
2. Download or open the repo.
3. Optionally refresh local game data if you are updating tables/assets.
4. Start the wiki and the listener.

The listener, event manager, shop, contract, mission, collection, and stamina systems can read installed `.luac` tables derived from the encrypted CounterSide assets next to `Data\Managed`. You only need part 3 when warming that cache, refreshing maintainer JSON fixtures, or extracting images for the wiki.

## Before You Start

You need:

- CounterSide installed through Steam.
- Access to this repo.
- About 10 GB of free disk space if you are extracting images.
- A little patience during the first asset extraction. It can take a while.

The default CounterSide install path used by this guide is:

```text
$HOME/.steam/steam/steamapps/common/CounterSide
```

If your game is installed somewhere else, that is fine. You will change one line later.

## Words This Guide Uses

- **Repo** means the RevivalSide folder that has `package.json`, `cs-listener.js`, `tools`, and `docs`.
- **Command** means a line you paste into terminal and run with Enter.
- **Listener** means `npm run listen`.
- **Wiki** means the local website started by `npm run wiki:serve`.

## Install The Tools

Install these first.

### 1. Node.js and npm

Install the current version with your package manager:

```console
sudo pacman -S nodejs npm
```

Node runs the RevivalSide listener and wiki tools.

### 2. .NET 8 SDK

Install the **.NET 8 SDK** with your package manager:

```console
sudo pacman -S dotnet-sdk-8.0
```

The SDK builds the C# combat host used by the listener.

### 3. Python and pip

On Linux, Python is often installed by default, but if you don't have it, run:

```console
sudo pacman -S python python-pip
```

### 4. Java

Install Java 17 or newer. 

```console
sudo pacman -S jdk-openjdk
```

Java is only needed for maintainer workflows that explicitly run `unluac` to refresh parsed table source. Normal listener startup does not use it.

### Optional: Git

Git is only needed if you want to clone or update the repo with `git pull`.

```console
sudo pacman -S git
```

If you do not want to install Git, download the repo as a ZIP from GitHub and extract it instead.

### Check That The Tools Work

Run:

```console
node -v
npm -v
dotnet --version
python --version
pip --version
java -version
```

You do not need the exact same versions as another person. You just want every command to print a version instead of an error like "not recognized".

If you installed Git, also run:

```console
git -v
```

If `git -v` works, you can use the Git clone steps below. If it does not, use the ZIP download path.

## Open The Repo Folder

If you already have the repo folder, open it in your terminal. 

```console
cd RevivalSide
```

If you downloaded a ZIP instead, extract it, and open the extracted `RevivalSide` folder in your terminal.

To confirm you are in the right folder:

```console
ls
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

```console
if [ ! -d ".env" ]; then cp ".env.example" ".env"; fi
npm install
npm run build:combat-host
```

What these do:

- `.env` is your local settings file.
- `npm install` downloads the JavaScript packages.
- `npm run build:combat-host` builds the C# combat host.

If your CounterSide install is not in the default Steam folder, open `.env` in your preferred text editor:

```console
nano .env
```

Find this line:

```text
CS_COUNTERSIDE_MANAGED_DIR=C:\Program Files (x86)\Steam\steamapps\common\CounterSide\Data\Managed
```

Change it to your real `Data\Managed` folder. The folder must contain `Assembly-CSharp.dll`.

## Refresh Local Game Data

The repo does not store raw game assets, raw DLLs, your account data, decrypted Lua bytecode, or decompiled Lua intermediates. Runtime table reads can use installed `.luac` assets, so run this section only when warming the local gameplay cache, rebuilding optional maintainer JSON fixtures, or extracting images.

Set a short variable for your CounterSide folder:

Fish:
```fish
set client "$HOME/.steam/steam/steamapps/common/CounterSide"
```

Bash:
```bash
client="$HOME/.steam/steam/steamapps/common/CounterSide"
```

If your game is installed somewhere else, change the path inside the quotes.

### Create and activate virtual environment

Run:

```console
python -m venv venv
source ./venv/bin/activate
```

You may need a different activate script depending on the shell you are using, for example:

```console
source ./venv/bin/activate.fish
```

### Install Python Packages

Run:

```console
python -m pip install UnityPy pillow
```

If `python` does not work on your machine, run:

```console
python3 -m pip install UnityPy pillow
```

### Build The Installed-Client Gameplay Cache

Run:

```console
npm run ensure:gameplay-assets
```

This starts from `CS_COUNTERSIDE_MANAGED_DIR` or the auto-detected Steam install, walks from `Data/Managed` to the installed encrypted `Data/StreamingAssets/ab_script*` bundles, and writes decrypted Lua bytecode to `.cache/gameplay-luac`. It does not run `unluac` or rebuild parsed/decompiled table dumps.

### Build The Server Data Indexes

Run:

```console
python ./tools/cs_build_server_data.py --parsed-root ./gameplay-jsons/StreamingAssets --out-dir ./server-data
```

This creates compact server files like `server-data/units.json`.

### Optional: Extract Images For The Wiki

The wiki works without images, but it is much nicer with PNGs.

First decrypt asset bundle headers:

```console
python ./tools/cs_asset_decrypt.py decrypt-header --all-assets --root "$client/Data/StreamingAssets" --out-dir ./extracted-assets/decrypted --overwrite
```

Then extract readable assets:

```console
python ./tools/cs_extract_decrypted_assets.py --root ./extracted-assets/decrypted --out-dir ./extracted-assets/all --manifest ./extracted-assets/manifest.json --overwrite-manifest
```

This can take a while. If you only care about IDs and text data, you can skip image extraction.

## Start The Wiki

From the repo folder, build the wiki data:

```console
npm run wiki:build
```

Then start the local wiki website:

```console
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

### Patch Hosts

This step redirects the game's login/CDN hostnames to your own computer.

Run:

```console
chmod +x .\tools\patch-hosts.sh
sudo .\tools\patch-hosts.sh
```

You should see a message saying the hosts file was updated and backed up.

To undo this later, run this:

```console
sudo .\tools\patch-hosts.sh -remove
```

If the normal official game stops loading later, remove the hosts patch or restart after removing it.

### Run The Listener

Open a normal terminal window in the repo folder and run:

```console
npm run listen
```

Good startup signs:

```text
[+] Listening on port 22000
[+] Captured HTTP mirror listening on http://127.0.0.1:8088
[+] User manager listening on http://127.0.0.1:8088/user-manager
```

Keep this terminal window open. This window is now the local server log.

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

To stop the wiki or listener, click the terminal window and press:

```text
Ctrl+C
```

If you want the normal official game again, remove the hosts patch:

```console
sudo .\tools\patch-hosts.sh -remove
```

Then close and reopen the game.

## Everyday Startup

After the first setup is done, most days are much shorter.

### Wiki

```console
npm run wiki:build
npm run wiki:serve
```

### Listener

```console
npm run listen
```

Make sure the hosts patch is enabled before starting the game.

## Updating Later

If you cloned with Git:

```console
git pull
npm install
npm run build:combat-host
```

If game data changed after a CounterSide update, rebuild the local game data section too.

## Common Problems

### `node` or `npm` is not recognized

Make sure you have installed Node.js LTS and npm:

```console
pacman -Q nodejs npm
```

### `dotnet` is not recognized

Make sure you have installed .NET 8 SDK. Other versions may not work, using `dotnet-sdk-8.0` is recommended.

```console
pacman -Q dotnet-sdk-8.0
```

### `python` is not recognized

Use `python3` instead of `python`. 

### Java errors during decompile

Run `java -version`. If it fails, install Java 17 or newer:

```console
sudo pacman -S jdk-openjdk
```

### `Assembly-CSharp.dll` cannot be found

Open `.env` and fix:

```text
CS_COUNTERSIDE_MANAGED_DIR=...
```

It must point to the `Data\Managed` folder inside CounterSide.

### The listener starts, but the game does not connect

Check these:

- The listener is still running.
- Admin terminal hosts patch was run.
- `.env` still has `CS_PORT=22000`.
- No other program is using port `22000`.
- CounterSide was restarted after patching hosts.

### The normal official game no longer loads

Remove the hosts patch:

```console
sudo .\tools\patch-hosts.sh -remove
```

Then restart CounterSide. If system is still being stubborn, restart the computer.

### Port `8088` or `22000` is already in use

Close old listener windows first. If that does not work, restart your computer or change the ports in `.env`.

### `npm install` fails

Check your internet connection and Node.js install. Then run:

```console
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
