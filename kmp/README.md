# RevivalSide Android

Android companion app for running RevivalSide phone-side tooling beside the Android CounterSide client.

## Current Capabilities

- Uses the Android `VpnService` only for explicit official-profile capture.
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
- Validates the installed Counter:Side version and RevivalSide endpoint patch before normal play.
- Runs normal ServerInfo, asset-download, login, and game traffic through Android's kernel TCP stack instead of the gameplay VPN proxy.
- Persists target package, ports, redirect ports, JOIN_LOBBY_ACK mode, and optional Android node path.

The Android app intentionally replaces Windows-only setup pieces with Android equivalents. Npcap/Wireshark becomes opt-in VPN capture, while normal play uses the patched client's local ServerInfo endpoint and the exact same listener payload as PC.

## Offline Payload ZIP

Public Android releases use one cloud-drive ZIP instead of a public loose-file CDN. The user downloads the matching ZIP, taps **IMPORT PAYLOAD ZIP**, and selects it with Android's system file picker. RevivalSide streams it into private app storage, verifies the APK-embedded manifest plus every file size and SHA-256, then serves the activated cache from `127.0.0.1:8088` to Counter:Side's built-in downloader. No root, broad storage permission, ADB tunnel, or write access to Counter:Side's protected app directory is required.

Package the rootless cloud-drive ZIP from the complete Android host tree with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ..\tools\package-android-offline-payload.ps1 -Force
```

The selected ZIP must stay intact and requires roughly 12.6 GB of additional free space while importing the current payload.

## MuMu CounterSide Install

Start MuMu and make sure ADB is reachable, then run:

```powershell
.\install-counterside-xapk.ps1
```

By default this connects to `10.0.2.240:5555` and installs:

- `com.studiobside.CounterSide.apk`
- `config.armeabi_v7a.apk`

from `C:\Users\moemy\Downloads\CounterSide_9.21.3352381_APKPure.xapk`.

For normal RevivalSide play, patch and sign the user-supplied XAPK/split directory first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ..\tools\patch-counterside-android-client.ps1 `
  -InputPath C:\path\to\CounterSide.xapk
```

The tool patches both the fixed-width IL2CPP endpoint and Gamebase's launching response passed to Unity, 16 KB-aligns every APK, signs every split with one key, verifies the result, and writes `patched-client.json`. Pass a stable release keystore for public builds; its default debug key is only for local testing.

## Build And Run

Refresh the bundled Node runtime when needed:

```powershell
.\vendor-nodejs-mobile.ps1
```

Stage the exact `core` and `game-data` components from the matching PC release. This also bundles the Android C# combat runtime, required managed assemblies, and gameplay tables so profile import and gameplay cannot ship with the combat host disabled:

```powershell
$release = "..\prebuilt\revivalside-github-release"
$core = Get-ChildItem $release\RevivalSide-core-*.zip | Select-Object -First 1 -ExpandProperty FullName
$gameData = Get-ChildItem $release\RevivalSide-game-data-*.zip | Select-Object -First 1 -ExpandProperty FullName
$androidHost = "..\dist\CounterSide-Android-9.21.3352381-host"
.\build-android-listener-assets.ps1 `
  -PayloadZip $core,$gameData `
  -PayloadManifest $release\RevivalSideReleaseManifest.json `
  -AndroidScriptBundle "..\prebuilt\android-client-assets\ab_script" `
  -AndroidPatchInfo "$androidHost\patchfiles\Android\ANDROID_335570\PatchInfo.json" `
  -AndroidLuaCacheZip "..\prebuilt\android-lua-cache-9.21.3352381.zip" `
  -AndroidLuaCacheManifest "..\prebuilt\android-lua-cache-9.21.3352381.json" `
  -AndroidClientPayloadManifest "$androidHost\payload-manifest.json" `
  -AndroidClientCdnBaseUrl "https://assets.example.com/patchfiles/"
```

For a normal release, `tools/build-android-resource-release.ps1 -AssetCdnBaseUrl ...` performs this staging automatically. The Lua cache manifest is validated, but the cache archive is never duplicated in the APK because the complete imported or external payload already contains it.

Then build/install:

```bat
build-and-install.bat
```

Then open **RevivalSide Android**.

Recommended smoke flow:

1. Tap **START**.
2. RevivalSide validates the installed Counter:Side version and endpoint patch.
3. CounterSide launches after the local listener, lobby cache, and managed combat host are ready.
4. Watch the Activity log and Android logcat.

For official profile capture, tap **ACK JSON**, reach the official lobby, then return to RevivalSide Android and tap **EXTRACT**. The app copies the latest `JOIN_LOBBY_ACK` bundle into `server-data/captured-game-flow`, imports it through the embedded listener, and switches the imported profile active.

## Listener Payload

The debug APK bundles:

- Node.js Mobile `v18.20.4` native libraries for `armeabi-v7a` and `arm64-v8a`.
- A small JNI bridge library that starts Node in a background thread.
- The PC release's listener and game-data component contents under `assets/revivalside-payload.zip`, with only the Android official/RevivalSide server-switch compatibility route added to the listener.
- Android-only managed combat and .NET files under `assets/revivalside-listener`; this directory is never overlaid onto the shared listener.
- A complete PC gameplay-table archive for the managed listener. Counter:Side's Unity bundles and ExtraAsset cache remain on the configured CDN.

The Android service extracts the shared listener, gameplay tables, and Android platform files into separate content-addressed directories. Obsolete versions are removed only after the new version is complete. Profiles, server time, captures, and logs stay in the persistent `server-data`/`logs` directories.

The listener refuses to start if the shared payload, gameplay archive, or Android platform manifest is missing; it no longer falls back to a partial listener overlay.

## Notes

- The app validates the patched Counter:Side APK. `tools/patch-counterside-android-client.ps1` performs the reproducible patch/sign step on a user-supplied XAPK.
- The app does not require root.
- Normal gameplay can run alongside another Android VPN; only official-profile capture needs RevivalSide's VPN.
- IPv4 is required only for the optional capture bridge.
- Standalone payload builds include Android arm and arm64 .NET combat hosts. Compact diagnostic builds still require `-IncludeSteamManagedCombatHost -IncludeAndroidDotnetRuntime` when managed combat is needed.
