param(
  [string]$PayloadRoot = "",
  [string]$PcReleaseDir = "",
  [string]$AssetCdnBaseUrl = "",
  [string]$GameplayTables = "",
  [string]$ModTables = "",
  [string]$AndroidScriptBundle = "",
  [switch]$AllowAdbLoopbackCdn
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $PayloadRoot) { $PayloadRoot = Join-Path $repo "dist\CounterSide-Android-9.21.3352381-host" }
if (-not $PcReleaseDir) { $PcReleaseDir = Join-Path $repo "prebuilt\revivalside-github-release" }
if (-not $GameplayTables) { $GameplayTables = Join-Path $repo "gameplay-tables" }
if (-not $ModTables) { $ModTables = Join-Path $repo "mods\.runtime\current" }
if (-not $AndroidScriptBundle) { $AndroidScriptBundle = Join-Path $repo "prebuilt\android-client-assets\ab_script" }

$payload = (Resolve-Path -LiteralPath $PayloadRoot).Path
$sourcePatchInfo = Join-Path $payload "source-manifests\LatestPatchInfo.json"
$sourceBytes = [IO.File]::ReadAllBytes($sourcePatchInfo)
$sourcePrefix = [Text.Encoding]::ASCII.GetString($sourceBytes, 0, [Math]::Min(256, $sourceBytes.Length))
$sourceVersion = [regex]::Match($sourcePrefix, 'ANDROID_\d+').Value
if (-not $sourceVersion) { throw "Android source PatchInfo has no version: $sourcePatchInfo" }

$existingManifest = Get-Content -LiteralPath (Join-Path $payload "payload-manifest.json") -Raw | ConvertFrom-Json
$bundleRoot = Join-Path $payload "patchfiles\Android\$($existingManifest.patchVersion)"
if (-not (Test-Path -LiteralPath $bundleRoot -PathType Container)) {
  $bundleRoot = Join-Path $payload "patchfiles\Android\$sourceVersion"
}
$scriptBundles = @(Get-ChildItem -LiteralPath $bundleRoot -File | Where-Object Name -like 'ab_script*' | Sort-Object Name | Select-Object -ExpandProperty FullName)
if ($scriptBundles.Count -eq 0) { throw "No Android script bundles were found in $bundleRoot" }

$lobbyBundle = Join-Path $bundleRoot "ab_ui_nkm_ui_lobby.asset"
if (-not (Test-Path -LiteralPath $lobbyBundle -PathType Leaf)) {
  throw "Android lobby bundle was not found: $lobbyBundle"
}
$clientParityBundleRoot = Join-Path $repo "prebuilt\android-client-parity-bundles"
$patchedLobbyBundle = Join-Path $clientParityBundleRoot "ab_ui_nkm_ui_lobby.asset"
& py (Join-Path $repo "tools\patch-android-lobby-counter-pass.py") `
  --bundle $lobbyBundle `
  --out $patchedLobbyBundle
if ($LASTEXITCODE -ne 0) { throw "Android Counter Pass lobby patch failed with exit code $LASTEXITCODE" }

$cacheZip = Join-Path $repo "prebuilt\android-lua-cache-9.21.3352381.zip"
$cacheManifest = Join-Path $repo "prebuilt\android-lua-cache-9.21.3352381.json"
$cacheArgs = @(
  (Join-Path $repo "tools\build-android-lua-cache.py"),
  "--patch-version", $sourceVersion,
  "--output-zip", $cacheZip,
  "--output-manifest", $cacheManifest,
  "--output-host-root", $payload,
  "--gameplay-tables", (Resolve-Path -LiteralPath $GameplayTables).Path
)
if (Test-Path -LiteralPath $ModTables -PathType Container) {
  $cacheArgs += @("--mod-tables", (Resolve-Path -LiteralPath $ModTables).Path)
}
$cacheArgs += $scriptBundles
& py @cacheArgs
if ($LASTEXITCODE -ne 0) { throw "Android ExtraAsset cache build failed with exit code $LASTEXITCODE" }

$packageArgs = @(
  (Join-Path $repo "tools\package-android-client-payload.js"),
  $payload,
  "--version-name", [string]$existingManifest.versionName,
  "--version-code", [string]$existingManifest.versionCode,
  "--script-bundle", (Resolve-Path -LiteralPath $AndroidScriptBundle).Path
)
$packageArgs += @("--android-mod-bundles", (Resolve-Path -LiteralPath $clientParityBundleRoot).Path)
$profilePath = Join-Path $repo "mods\profile.json"
if (Test-Path -LiteralPath $profilePath) {
  $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
  foreach ($modId in @($profile.enabled)) {
    $androidBundles = Join-Path $repo "mods\$modId\assets\android-bundles"
    if (Test-Path -LiteralPath $androidBundles -PathType Container) {
      $packageArgs += @("--android-mod-bundles", $androidBundles)
    }
  }
}
& node @packageArgs
if ($LASTEXITCODE -ne 0) { throw "Android payload packaging failed with exit code $LASTEXITCODE" }
$hostedLobbyBundle = Join-Path $bundleRoot "ab_ui_nkm_ui_lobby.asset"
& py (Join-Path $repo "tools\patch-android-lobby-counter-pass.py") --bundle $hostedLobbyBundle --check
if ($LASTEXITCODE -ne 0) { throw "Hosted Android Counter Pass lobby patch verification failed with exit code $LASTEXITCODE" }
if ((Get-FileHash -LiteralPath $hostedLobbyBundle -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $patchedLobbyBundle -Algorithm SHA256).Hash) {
  throw "Hosted Android lobby bundle differs from the verified Counter Pass parity bundle."
}

if ($AssetCdnBaseUrl) {
  $release = (Resolve-Path -LiteralPath $PcReleaseDir).Path
  $core = Get-ChildItem -LiteralPath $release -Filter "RevivalSide-core-*.zip" | Select-Object -First 1 -ExpandProperty FullName
  $gameData = Get-ChildItem -LiteralPath $release -Filter "RevivalSide-game-data-*.zip" | Select-Object -First 1 -ExpandProperty FullName
  if (-not $core -or -not $gameData) { throw "Matching PC core and game-data release components were not found in $release" }
  & (Join-Path $repo "kmp\build-android-listener-assets.ps1") `
    -PayloadZip @($core, $gameData) `
    -PayloadManifest (Join-Path $release "RevivalSideReleaseManifest.json") `
    -AndroidScriptBundle (Resolve-Path -LiteralPath $AndroidScriptBundle).Path `
    -AndroidPatchInfo (Join-Path $payload "patchfiles\Android\$sourceVersion\PatchInfo.json") `
    -AndroidLuaCacheZip $cacheZip `
    -AndroidLuaCacheManifest $cacheManifest `
    -AndroidClientPayloadManifest (Join-Path $payload "payload-manifest.json") `
    -AndroidClientCdnBaseUrl $AssetCdnBaseUrl `
    -AllowAdbLoopbackCdn:$AllowAdbLoopbackCdn
  if ($LASTEXITCODE -ne 0) { throw "Android KMP listener staging failed with exit code $LASTEXITCODE" }
  & node (Join-Path $repo "tools\check-android-resource-parity.js")
  if ($LASTEXITCODE -ne 0) { throw "Android resource parity failed with exit code $LASTEXITCODE" }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "kmp\check-android-listener-parity.ps1")
  if ($LASTEXITCODE -ne 0) { throw "Android listener parity failed with exit code $LASTEXITCODE" }
}

Write-Host "Android resource release ready version=$sourceVersion payload=$payload"
if (-not $AssetCdnBaseUrl) {
  Write-Host "Payload host tree was built. Pass -AssetCdnBaseUrl https://host/patchfiles/ to stage the matching KMP contract."
}
