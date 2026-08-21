# Android Client Payload

The recommended Android release is one RevivalSide APK plus one versioned payload ZIP. Put the ZIP on any cloud drive; users download it themselves and select **IMPORT PAYLOAD ZIP** in RevivalSide. The app verifies the embedded manifest and every file hash, activates the payload atomically, then serves it to Counter:Side from the phone itself.

Normal play uses two phone-local endpoints:

- `http://127.0.0.1:8088/revivalsideapk/server_config/live/ServerInfo_V2.json` is served by the phone-side listener. The patched Counter:Side client asks this endpoint for its game server and CDN.
- `http://127.0.0.1:8088/patchfiles/` serves the imported native Android and ExtraAsset payload through Counter:Side's built-in downloader.

The cloud provider is not part of the runtime protocol, so redirects, expiring share links, quotas, and provider APIs cannot break gameplay after the ZIP is downloaded.

## Build the payload

Start with the APK/XAPK and native Android asset cache for one Counter:Side version. Build the matching PC 0.4.0 components first, then use the release builder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-revivalside-github-release.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-android-resource-release.ps1 `
  -AssetCdnBaseUrl "http://127.0.0.1:8088/patchfiles/" `
  -AllowAdbLoopbackCdn
powershell -NoProfile -ExecutionPolicy Bypass -File tools/package-android-offline-payload.ps1
```

The release builder keeps Android, PC, and ExtraAsset on the source content number; it does not invent a version bump. It validates native `PatchInfo.json` MD5/size records, injects the patched Android script bundle, compiles a complete ExtraAsset cache with PC Lua tables overriding matching Android tables, adds Android-only tables and active Mod:Side overlays, and writes SHA-256 records for every hosted file. It also stages the KMP contract from the exact PC `core` and `game-data` archives.

Run the hard parity gates before publishing:

```powershell
npm run check:android-resources
powershell -NoProfile -ExecutionPolicy Bypass -File kmp/check-android-listener-parity.ps1
```

For Counter:Side 9.21.3352381 the source tree is `dist/CounterSide-Android-9.21.3352381-host`. Upload the generated `RevivalSide-Android-payload-*.zip` to the cloud drive without recompressing or renaming its contents. Publish its adjacent JSON metadata and SHA-256 so mirrors can be checked independently.

## Optional public host

The same payload tree can still be served from a public HTTPS host instead of distributing a ZIP:

```powershell
$env:CS_ANDROID_CLIENT_PAYLOAD_DIR = "C:\payloads\CounterSide-Android-9.21.3352381-host"
$env:CS_HTTP_LISTEN_HOST = "0.0.0.0"
$env:CS_HTTP_MIRROR_HOST = "assets.example.com"
$env:CS_HTTP_MIRROR_BASE_URL = "https://assets.example.com"
node server/listener.js
```

Put a normal TLS reverse proxy in front of the HTTP listener. The service exposes:

- `/android-client/payload-manifest.json`
- `/patchfiles/Android/liveVersion.json`
- `/patchfiles/Android/<version>/PatchInfo.json`
- `/patchfiles/ExtraAsset/liveVersion.json`
- `/patchfiles/ExtraAsset/<version>/PatchInfo.json`
- every versioned asset named by `PatchInfo.json`

Payload files support `HEAD`, ETag, immutable caching, and resumable single-byte ranges. Startup validates every manifest path and file size before accepting requests.

## Build the Android companion

Pass the same payload manifest and public CDN URL to `kmp/build-android-listener-assets.ps1`, or let `build-android-resource-release.ps1` do it. The script writes `revivalside-android-client-contract.json`; the Android app and the client patcher consume that one contract, so version name, version code, patch version, payload hash/count/size, local ServerInfo URL, and CDN cannot drift independently. Hosted builds do not duplicate the full ExtraAsset cache inside the APK.

Normal play does not request storage permission. Counter:Side downloads the asset payload through its own downloader and writes into its own app-private storage. RevivalSide cannot safely write another app's private data on current Android without root.
