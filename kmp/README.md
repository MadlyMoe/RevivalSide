# RevivalSide Android

Android companion app for running RevivalSide phone-side tooling beside the Android CounterSide client.

## Current Capabilities

- Runs as an Android `VpnService`.
- Captures `JOIN_LOBBY_ACK` from the official Android client and exports the existing desktop import bundle.
- Extracts the latest `JOIN_LOBBY_ACK` capture into the embedded listener data directory and imports it as the active local profile.
- Starts a foreground RevivalSide listener service with bundled Node.js Mobile.
- Serves the RevivalSide listener and launcher-compatible endpoints on `127.0.0.1:8088`:
  - `GET /launcher/api/health`
  - `GET /launcher/api/official-profile/sources`
  - `POST /launcher/api/official-profile/import-latest`
  - `GET /launcher/api/server-time`
  - `POST /launcher/api/server-time`
  - `POST /launcher/api/server-time/clear`
  - `POST /user-manager/api/reload`
- Redirects selected CounterSide TCP ports through the VPN to the local phone listener port.
- Persists target package, ports, redirect ports, JOIN_LOBBY_ACK mode, and optional Android node path.

The Android app intentionally replaces Windows-only setup pieces with Android equivalents. Npcap/Wireshark becomes VPN capture, hosts patching becomes VPN redirect, and the setup wizard becomes in-app controls.

## MuMu CounterSide Install

Start MuMu and make sure ADB is reachable, then run:

```powershell
.\install-counterside-xapk.ps1
```

By default this connects to `10.0.2.240:5555` and installs:

- `com.studiobside.CounterSide.apk`
- `config.armeabi_v7a.apk`

from `C:\Users\moemy\Downloads\CounterSide_9.21.3352381_APKPure.xapk`.

## Build And Run

Refresh the bundled Node runtime and JS listener payload when needed:

```powershell
.\vendor-nodejs-mobile.ps1
.\build-android-listener-assets.ps1
```

For a standalone phone build, stage the release payload archive too. This also bundles the Android C# combat runtime, required managed assemblies, and gameplay tables so profile import and gameplay cannot ship with the combat host disabled:

```powershell
.\build-android-listener-assets.ps1 -PayloadZip ..\prebuilt\revivalside-github-release\RevivalSidePayload-v0.3.5.zip
```

Then build/install:

```bat
build-and-install.bat
```

Then open **RevivalSide Android**.

Recommended smoke flow:

1. Tap **START**.
2. Accept the Android VPN prompt if asked.
3. CounterSide launches after listener warmup and VPN redirect are ready.
4. Watch the Activity log and Android logcat.

For official profile capture, tap **ACK JSON**, reach the official lobby, then return to RevivalSide Android and tap **EXTRACT**. The app copies the latest `JOIN_LOBBY_ACK` bundle into `server-data/captured-game-flow`, imports it through the embedded listener, and switches the imported profile active.

## Listener Payload

The debug APK bundles:

- Node.js Mobile `v18.20.4` native libraries for `armeabi-v7a`, `arm64-v8a`, and `x86_64`.
- A small JNI bridge library that starts Node in a background thread.
- Either the compact RevivalSide JS listener payload under `assets/revivalside-listener`, or a full release archive under `assets/revivalside-payload.zip`.
- Compact seed tables from `server-data` for diagnostic builds, excluding local users, logs, captures, backups, and large optional string/cache data.

When `revivalside-payload.zip` is present, the Android service extracts only `payload/app` into app-private storage. It preserves `server-data/users.json`, `server-data/server-time.json`, logs, captures, and exports across app starts, and it runs the listener in packaged-only mode with desktop `Assembly-CSharp.dll` discovery disabled.

Stage the JS files with:

```powershell
.\build-android-listener-assets.ps1
```

Use `-IncludeGameplayJsons` or `-IncludeLargeServerData` only for oversized diagnostic APKs.

The fallback Kotlin control API is used only if the bundled Node runtime or listener payload is missing.

## Notes

- The app does not patch the CounterSide APK.
- The app does not require root.
- It cannot run alongside another Android VPN.
- IPv4 is required for the current VPN packet bridge.
- Standalone payload builds include the existing Android arm64 .NET combat host. Compact diagnostic builds still require `-IncludeSteamManagedCombatHost -IncludeAndroidDotnetRuntime` when managed combat is needed.
