# DownloadSide

RevivalSide v0.3.5 release payloads live in GitHub releases on `MadlyMoe/RevivalSide`. Setup downloads the manifest and payload assets directly from the release URL baked into the setup executable.

DownloadSide remains in `download-service` as a legacy Discord-gated proxy service, but v0.3.5 Setup and Launcher do not use Discord OAuth, device codes, install tokens, or bearer-token release downloads. Redistributable apps must never contain a GitHub token, Discord client secret, or GitHub App private key.

## Required Environment

```text
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=
DISCORD_GUILD_ID=
DISCORD_ALLOWED_ROLE_ID=
SESSION_SECRET=
GITHUB_OWNER=MadlyMoe
GITHUB_REPO=RevivalSide
GITHUB_TOKEN=
SERVICE_NAME=DownloadSide
DOWNLOAD_PUBLIC_BASE_URL=https://downloadside.fly.dev
```

`GITHUB_TOKEN` can be replaced with GitHub App credentials; see `download-service\.env.example`.

## Packaging Command

For the direct GitHub `v0.3.5` release:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-revivalside-github-release.ps1 -ReleaseTag v0.3.5 -Upload
```

The package script derives the base URL from the `RevivalSide` or `origin` GitHub remote:

```text
https://github.com/MadlyMoe/RevivalSide/releases/download/v0.3.5
```

Upload the generated setup executable, `RevivalSidePayloadManifest.json`, and payload archive or parts to the `MadlyMoe/RevivalSide` release. Do not upload the payload to Discord.

## Hosting

`download-service\Dockerfile` and `download-service\fly.toml` define the DownloadSide Fly.io deployment at `https://downloadside.fly.dev`.

```powershell
cd C:\Main\Productivity\StopKillingGames\Projects\RevivalSide\download-service
flyctl auth login
flyctl apps create downloadside
npm run secrets:fly
npm run deploy:fly
Invoke-RestMethod https://downloadside.fly.dev/health
```

`npm run secrets:fly` reads non-empty DownloadSide deploy variables from `download-service\.env` and stages them with `flyctl secrets import --stage`. `npm run deploy:fly` applies the staged secrets.

## Setup Flow

1. Setup fetches the baked `RevivalSidePayloadManifest.json` URL.
2. Setup downloads the archive or split payload parts listed in the manifest.
3. Setup validates payload SHA-256 hashes.
4. Setup extracts the payload and installs it into `%LOCALAPPDATA%\RevivalSide`.

Setup does not open Discord, request a device code, poll `/auth/device`, or send `Authorization: Bearer` for release downloads.

## Launcher Flow

Launcher does not perform Discord entitlement checks. After Setup finishes downloading and installing the payload, Launcher starts the local listener directly through the existing `npm run listen` path.
