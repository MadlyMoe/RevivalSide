param(
  [switch]$ReleaseSnapshot
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$assets = Join-Path $PSScriptRoot "app\src\main\assets"
$payloadPath = Join-Path $assets "revivalside-payload.zip"
$payloadManifestPath = Join-Path $assets "revivalside-payload-manifest.json"
$gameplayTablesManifestPath = Join-Path $assets "revivalside-gameplay-tables-manifest.json"
$platformRoot = Join-Path $assets "revivalside-listener"
$platformManifestPath = Join-Path $assets "revivalside-platform-manifest.json"
$clientContractPath = Join-Path $assets "revivalside-android-client-contract.json"
$servicePath = Join-Path $PSScriptRoot "app\src\main\kotlin\dev\revivalside\capture\android\RevivalSideListenerService.kt"
$activityPath = Join-Path $PSScriptRoot "app\src\main\kotlin\dev\revivalside\capture\android\MainActivity.kt"
$vpnServicePath = Join-Path $PSScriptRoot "app\src\main\kotlin\dev\revivalside\capture\android\CounterSideVpnService.kt"
$captureRepositoryPath = Join-Path $PSScriptRoot "app\src\main\kotlin\dev\revivalside\capture\android\CaptureRepository.kt"
$androidManifestPath = Join-Path $PSScriptRoot "app\src\main\AndroidManifest.xml"
$settingsPath = Join-Path $PSScriptRoot "app\src\main\kotlin\dev\revivalside\capture\android\RevivalSideSettings.kt"
$payloadCachePath = Join-Path $PSScriptRoot "app\src\main\kotlin\dev\revivalside\capture\android\AndroidPayloadCache.kt"
$payloadHttpServerPath = Join-Path $PSScriptRoot "app\src\main\kotlin\dev\revivalside\capture\android\AndroidPayloadHttpServer.kt"
$gradlePath = Join-Path $PSScriptRoot "app\build.gradle.kts"
$listenerSourcePath = Join-Path $repo "server\listener.js"
$officialBridgePatcher = Join-Path $repo "tools\patch-android-official-server-bridge.js"

if (-not (Test-Path -LiteralPath $officialBridgePatcher -PathType Leaf)) {
  throw "Android official-server bridge patcher is missing: $officialBridgePatcher"
}
& node $officialBridgePatcher --self-test | Write-Host
if ($LASTEXITCODE -ne 0) { throw "Android official-server bridge patcher self-test failed." }

$version = (Get-Content -Raw -LiteralPath (Join-Path $repo "package.json") | ConvertFrom-Json).version
$gradle = Get-Content -Raw -LiteralPath $gradlePath
if ($gradle -notmatch ('versionName\s*=\s*"' + [regex]::Escape($version) + '"')) {
  throw "Android versionName does not match PC package version $version."
}

$payloadManifest = Get-Content -Raw -LiteralPath $payloadManifestPath | ConvertFrom-Json
if ($payloadManifest.sourcePayloadId -ne "revivalside-v$version" -or $payloadManifest.releaseTag -ne "v$version") {
  throw "Android payload does not identify the PC v$version payload."
}
$payloadHash = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($payloadHash -ne "$($payloadManifest.archiveSha256)".ToLowerInvariant()) {
  throw "Android payload archive hash does not match its manifest."
}
$clientContract = Get-Content -Raw -LiteralPath $clientContractPath | ConvertFrom-Json
if ($clientContract.schemaVersion -ne 1 -or
    $clientContract.packageName -ne "com.studiobside.CounterSide" -or
    $clientContract.localHttpPort -ne 8088 -or
    $clientContract.patchVersion -notmatch '^ANDROID_\d+$' -or
    -not $clientContract.payloadId -or
    [long]$clientContract.payloadFileCount -le 0 -or
    [long]$clientContract.payloadTotalBytes -le 0 -or
    $clientContract.payloadManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
    $clientContract.originalServerInfoBaseUrl.Length -ne $clientContract.patchedServerInfoBaseUrl.Length -or
    $clientContract.assetCdnBaseUrl -notmatch '^https?://') {
  throw "Android client version/endpoint/CDN contract is invalid."
}
$gameplayTablesManifest = Get-Content -Raw -LiteralPath $gameplayTablesManifestPath | ConvertFrom-Json
if ($gameplayTablesManifest.contentsVersion -notmatch '^\d{1,4}\.\d{1,4}\.[A-Za-z0-9_-]{1,16}$') {
  throw "Android gameplay table manifest has no PC content version."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($payloadPath)
$sharedFiles = @()
$packagedListenerSource = ""
$packagedStageSource = ""
try {
  $entries = @{}
  foreach ($entry in $zip.Entries) { $entries[$entry.FullName] = $entry }
  $packagedListenerEntry = $entries["payload/app/server/listener.js"]
  if (-not $packagedListenerEntry) { throw "Android payload is missing payload/app/server/listener.js." }
  $packagedListenerStream = $packagedListenerEntry.Open()
  try {
    $reader = [System.IO.StreamReader]::new($packagedListenerStream, [System.Text.Encoding]::UTF8, $true, 4096, $true)
    try { $packagedListenerSource = $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally {
    $packagedListenerStream.Dispose()
  }
  $packagedStageEntry = $entries["payload/app/stages/mainStoryStage.js"]
  if (-not $packagedStageEntry) { throw "Android payload is missing payload/app/stages/mainStoryStage.js." }
  $packagedStageStream = $packagedStageEntry.Open()
  try {
    $stageReader = [System.IO.StreamReader]::new($packagedStageStream, [System.Text.Encoding]::UTF8, $true, 4096, $true)
    try { $packagedStageSource = $stageReader.ReadToEnd() } finally { $stageReader.Dispose() }
  } finally {
    $packagedStageStream.Dispose()
  }

  if (-not $ReleaseSnapshot) {
    $sharedFiles = @("cs-listener.js", "package.json", "packet-schema.json")
    foreach ($directory in @("server", "modules", "packet-handlers", "combat-handler", "stages")) {
      $sharedFiles += Get-ChildItem -LiteralPath (Join-Path $repo $directory) -Recurse -File | ForEach-Object {
        $_.FullName.Substring($repo.Length + 1).Replace('\', '/')
      }
    }
    foreach ($relative in $sharedFiles) {
      $entryName = "payload/app/$($relative.Replace('\', '/'))"
      $entry = $entries[$entryName]
      if (-not $entry) { throw "Android payload is missing shared PC listener file $relative." }
      $sourceHash = (Get-FileHash -LiteralPath (Join-Path $repo $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
      $stream = $entry.Open()
      try {
        $entryHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
      } finally {
        $stream.Dispose()
      }
      if ($entryHash -ne $sourceHash) { throw "Android payload differs from the PC listener at $relative." }
    }
  }

  $pcPayloadRoot = Join-Path $repo "prebuilt\revivalside-universal-installer\payload\app"
  if (-not $ReleaseSnapshot -and (Test-Path -LiteralPath $pcPayloadRoot -PathType Container)) {
    $pcPayloadFiles = @(Get-ChildItem -LiteralPath $pcPayloadRoot -Recurse -File | Where-Object {
      $relative = $_.FullName.Substring($pcPayloadRoot.Length + 1).Replace('\', '/')
      $relative -ne ".env" -and -not $relative.StartsWith("wiki/")
    })
    if ($pcPayloadFiles.Count -ne $entries.Count) {
      throw "Android payload file count differs from the PC core + game-data payload."
    }
    foreach ($file in $pcPayloadFiles) {
      $relative = $file.FullName.Substring($pcPayloadRoot.Length + 1).Replace('\', '/')
      $entry = $entries["payload/app/$relative"]
      if (-not $entry) { throw "Android payload is missing PC release file $relative." }
      $sourceHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $stream = $entry.Open()
      try {
        $entryHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
      } finally {
        $stream.Dispose()
      }
      if ($entryHash -ne $sourceHash) { throw "Android payload differs from the PC release at $relative." }
    }
  }
} finally {
  $zip.Dispose()
}

foreach ($forbidden in @("server", "modules", "packet-handlers", "combat-handler", "stages", "cs-listener.js", "package.json", "packet-schema.json")) {
  if (Test-Path -LiteralPath (Join-Path $platformRoot $forbidden)) {
    throw "Android-only platform assets contain a duplicate listener path: $forbidden"
  }
}
$platformManifest = Get-Content -Raw -LiteralPath $platformManifestPath | ConvertFrom-Json
$platformRecords = Get-ChildItem -LiteralPath $platformRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
  $relative = $_.FullName.Substring($platformRoot.Length).TrimStart('\', '/').Replace('\', '/')
  "$relative|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
}
$platformBytes = [System.Text.Encoding]::UTF8.GetBytes(($platformRecords -join "`n"))
$platformHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($platformBytes)).Replace("-", "").ToLowerInvariant()
if ($platformHash -ne "$($platformManifest.treeSha256)".ToLowerInvariant()) {
  throw "Android platform assets do not match their manifest."
}

$service = Get-Content -Raw -LiteralPath $servicePath
foreach ($required in @(
  'env["CS_REPLAY_CAPTURED_LOGIN_ACK"] = "0"',
  'process.env.CS_REPLAY_CAPTURED_LOGIN_ACK = "0"',
  'env["CS_EVENT_DATE"] = settings.eventDate',
  'env["CS_UNLOCK_ALL_SUBSTREAMS"] = "1"',
  'process.env.CS_EVENT_DATE = ${jsString(settings.eventDate)}',
  'process.env.CS_UNLOCK_ALL_SUBSTREAMS = "1"',
  'env["CS_LOGIN_BACKGROUND"] = settings.loginBackground',
  'process.env.CS_LOGIN_BACKGROUND = ${jsString(settings.loginBackground)}',
  'installVersionedArchive(',
  'process.env.CS_CSHARP_COMBAT_HOST_DLL =',
  'process.env.CS_ANDROID_CLIENT_CDN_BASE_URL =',
  'env["CS_ANDROID_CLIENT_PAYLOAD_DIR"] = androidClientPayloadDir.absolutePath',
  'process.env.CS_ANDROID_CLIENT_PAYLOAD_DIR =',
  'payloadServer = AndroidPayloadHttpServer(',
  'AndroidPayloadCache.nodeMirrorPort(settings.httpPort)',
  'process.env.CS_REQUIRE_COMBAT_HOST = "1"',
  'env["CS_PRIVATE_PVP"] = "0"',
  'process.env.CS_PRIVATE_PVP = "0"',
  'ARCHIVE_PROGRESS_FILE_INTERVAL',
  'env["CS_FROZEN_SOURCE_CONTENTS_VERSION"] = paths.sourceContentsVersion',
  'process.env.CS_FROZEN_SOURCE_CONTENTS_VERSION = ${jsString(paths.sourceContentsVersion)}'
)) {
  if (-not $service.Contains($required)) { throw "Android listener parity contract is missing: $required" }
}
$payloadHttpServer = Get-Content -Raw -LiteralPath $payloadHttpServerPath
foreach ($required in @(
  'Executors.newFixedThreadPool(WORKER_COUNT)',
  'bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), SOCKET_BACKLOG)',
  'path == "/server_config/live/ServerInfo_V2.json"',
  '.put("cdn", "http://127.0.0.1:$port/patchfiles/")',
  'private const val WORKER_COUNT = 16',
  'private const val MAX_REQUESTS_PER_CONNECTION = 4096'
)) {
  if (-not $payloadHttpServer.Contains($required)) { throw "Android native payload server contract is missing: $required" }
}
foreach ($forbidden in @('ANDROID_MANAGED_HOST_TICK_INTERVAL_MS', 'Applied packaged RevivalSide listener overlay', 'private const val DEFAULT_EVENT_DATE')) {
  if ($service.Contains($forbidden)) { throw "Android listener still contains divergent behavior: $forbidden" }
}
$activity = Get-Content -Raw -LiteralPath $activityPath
foreach ($required in @(
  'validateInstalledAndroidClient(',
  'detectInstalledAndroidClient(',
  'AndroidClientMode.OFFICIAL',
  'AndroidClientMode.PATCHED',
  'validateAndroidPayloadHost(',
  'AndroidPayloadCache.validate(applicationContext)',
  'AndroidPayloadCache.importZip(applicationContext, uri)',
  'Intent.ACTION_OPEN_DOCUMENT',
  'requestListenerWarmup(settings)',
  'listenerHealthTimedOut()',
  'tryLaunchAfterStart()',
  'requestServerInfoMode(settings, SERVER_MODE_REVIVALSIDE)',
  '"EXTRACT GAME PROFILE"',
  '"DOWNLOAD ACTIVE PROFILE"',
  '"DOWNLOAD PATCHED APK"',
  'MediaStore.Downloads.EXTERNAL_CONTENT_URI',
  'CaptureRepository.hasPendingProfileImport(this)',
  'requestActiveProfileTarget(settings)',
  'https://discord.gg/revivalside',
  'eventDate = eventDateInput.text.toString().trim()',
  'loginBackground = RevivalSideSettingsStore.normalizeLoginBackground('
)) {
  if (-not $activity.Contains($required)) { throw "Android client launch parity contract is missing: $required" }
}
foreach ($forbidden in @('text = "OFFICIAL + ACK"', 'private lateinit var stopButton', 'private lateinit var captureButton', 'private lateinit var extractButton')) {
  if ($activity.Contains($forbidden)) { throw "Android launcher still contains the retired multi-button flow: $forbidden" }
}
$vpnService = Get-Content -Raw -LiteralPath $vpnServicePath
foreach ($required in @(
  'publishStatus("Captured JOIN_LOBBY_ACK", export)',
  'PROFILE_SAVED_NOTIFICATION_ID',
  'buildProfileSavedNotification()',
  'stopCapture()'
)) {
  if (-not $vpnService.Contains($required)) { throw "Android ACK completion contract is missing: $required" }
}
$captureRepository = Get-Content -Raw -LiteralPath $captureRepositoryPath
foreach ($required in @('KEY_PENDING_PROFILE_EXPORT', 'hasPendingProfileImport(', 'markLatestProfileImported(')) {
  if (-not $captureRepository.Contains($required)) { throw "Android automatic profile import contract is missing: $required" }
}
$payloadCache = Get-Content -Raw -LiteralPath $payloadCachePath
foreach ($required in @(
  'validateAndroidPayloadManifest(contract, manifestBytes)',
  'MessageDigest.getInstance("SHA-256")',
  'payload-manifest.json must be first',
  'StatFs(cacheRoot.absolutePath).availableBytes',
  'staging.renameTo(target)',
  'AndroidPayloadImportProgress('
)) {
  if (-not $payloadCache.Contains($required)) { throw "Android payload ZIP import contract is missing: $required" }
}
foreach ($forbidden in @('requestAndroidAssetReadiness(', 'val assetReadiness =')) {
  if ($activity.Contains($forbidden)) { throw "Android lobby warmup is still coupled to the asset CDN: $forbidden" }
}
if ($activity.Contains('beginVpnFlow(CounterSideVpnService.MODE_LISTENER)')) {
  throw "Normal Android gameplay still depends on the listener-mode VPN proxy."
}
$androidManifest = Get-Content -Raw -LiteralPath $androidManifestPath
if ($androidManifest -notmatch 'android:launchMode="singleTask"') {
  throw "Android launcher can create competing server-switch flows."
}
$listenerSource = if ($ReleaseSnapshot) { $packagedListenerSource } else { Get-Content -Raw -LiteralPath $listenerSourcePath }
if ($ReleaseSnapshot) {
  $hasLegacyBridge =
    $packagedListenerSource.Contains('url.pathname === "/launcher/api/server-info-mode"') -and
    $packagedListenerSource.Contains('rewriteCapturedServerInfo = serverInfoMode === "revivalside";')
  $hasIntegratedBridge =
    $packagedListenerSource.Contains('url.pathname === "/launcher/api/server-info-mode"') -and
    $packagedListenerSource.Contains('serverInfoMode = normalizeServerInfoMode(') -and
    $packagedListenerSource.Contains('function rewriteServerInfo(')
  if (-not ($hasLegacyBridge -or $hasIntegratedBridge)) {
    throw "Packaged Android official-server bridge is missing its server-info mode contract."
  }
  foreach ($required in @(
    'function buildCapturedLoginLikeAck(',
    'function buildLoginLikePayload(user)',
    'function getEffectiveContentsTags(baseTags)',
    'function getEffectiveOpenTags(baseTags)',
    'REQUIRED_CORE_OPEN_TAGS',
    'PRIVATE_PVP_OPEN_TAGS'
  )) {
    if (-not $packagedListenerSource.Contains($required)) {
      throw "Packaged Android login tag parity is missing: $required"
    }
  }
  foreach ($required in @('UNLOCK_ALL_SUBSTREAMS', 'SURT_UNIT_GET', 'SURT_CLEAR_DUNGEON_INTERVAL')) {
    if (-not $packagedStageSource.Contains($required)) {
      throw "Packaged Android substream compatibility is missing: $required"
    }
  }
  if ($hasLegacyBridge) {
    $expectedBlob = (& git -C $repo rev-parse "v$version`:server/listener.js").Trim()
    if ($LASTEXITCODE -ne 0 -or $expectedBlob -notmatch '^[a-f0-9]{40}$') {
      throw "Could not resolve the immutable PC v$version listener blob."
    }
    $temporaryListener = Join-Path ([System.IO.Path]::GetTempPath()) "revivalside-android-parity-$([guid]::NewGuid().ToString('N')).js"
    try {
      [System.IO.File]::WriteAllText($temporaryListener, $packagedListenerSource, [System.Text.UTF8Encoding]::new($false))
      & node $officialBridgePatcher --reverse $temporaryListener | Write-Host
      if ($LASTEXITCODE -ne 0) { throw "Could not remove the Android official-server bridge for baseline comparison." }
      $baselineBytes = [System.IO.File]::ReadAllBytes($temporaryListener)
      $headerBytes = [System.Text.Encoding]::ASCII.GetBytes("blob $($baselineBytes.Length)`0")
      $blobBytes = New-Object byte[] ($headerBytes.Length + $baselineBytes.Length)
      [System.Buffer]::BlockCopy($headerBytes, 0, $blobBytes, 0, $headerBytes.Length)
      [System.Buffer]::BlockCopy($baselineBytes, 0, $blobBytes, $headerBytes.Length, $baselineBytes.Length)
      $baselineBlob = [System.BitConverter]::ToString([System.Security.Cryptography.SHA1]::Create().ComputeHash($blobBytes)).Replace("-", "").ToLowerInvariant()
    } finally {
      Remove-Item -LiteralPath $temporaryListener -Force -ErrorAction SilentlyContinue
    }
    if ($baselineBlob -ne $expectedBlob) {
      throw "Android listener differs from PC v$version beyond the official-server bridge compatibility patch."
    }
  } else {
    Write-Host "Android listener uses the integrated PC release server-info bridge."
  }
} else {
  foreach ($required in @(
    'url.pathname === "/launcher/api/server-info-mode"',
    'serverInfoMode === "revivalside"',
    'serverInfoMode,',
    'normalizeServerInfoMode('
  )) {
    if (-not $listenerSource.Contains($required)) { throw "Shared listener server-switch contract is missing: $required" }
  }
}
$settings = Get-Content -Raw -LiteralPath $settingsPath
foreach ($required in @(
  'internal const val DEFAULT_EVENT_DATE = "2025-04-10"',
  'internal const val DEFAULT_LOGIN_BACKGROUND = "auto"',
  'val eventDate: String = DEFAULT_EVENT_DATE',
  'val loginBackground: String = DEFAULT_LOGIN_BACKGROUND'
)) {
  if (-not $settings.Contains($required)) { throw "Android settings differ from the PC launcher contract: $required" }
}

foreach ($abi in @("arm64-v8a", "armeabi-v7a")) {
  $hostLibrary = if ($abi -eq "arm64-v8a") { "libhostfxr.so" } else { "libmonosgen-2.0.so" }
  $rid = if ($abi -eq "arm64-v8a") { "android-arm64" } else { "android-arm" }
  $nativeManifest = Join-Path $platformRoot "combat-runtime\$rid\native-libraries.txt"
  if (-not (Test-Path -LiteralPath $nativeManifest -PathType Leaf)) {
    throw "Android ABI $abi is missing its native combat library manifest."
  }
  $manifestLibraries = @(Get-Content -LiteralPath $nativeManifest | Where-Object { $_.Trim() })
  if ($hostLibrary -notin $manifestLibraries) {
    throw "Android ABI $abi native combat manifest does not contain $hostLibrary."
  }
  foreach ($requiredLibrary in @(
    (Join-Path $PSScriptRoot "app\libnode\bin\$abi\libnode.so"),
    (Join-Path $PSScriptRoot "app\src\main\jniLibs\$abi\liblua54.so"),
    (Join-Path $PSScriptRoot "app\src\main\jniLibs\$abi\$hostLibrary")
  )) {
    if (-not (Test-Path -LiteralPath $requiredLibrary -PathType Leaf)) {
      throw "Android ABI $abi is missing required native library $requiredLibrary."
    }
  }
}

foreach ($required in @('Os.symlink(', 'prepareDeviceCombatRuntime(target)', 'native-libraries.txt')) {
  if (-not $service.Contains($required)) {
    throw "Android listener does not relink packaged native combat libraries on install/update: $required"
  }
}

$parityTarget = if ($ReleaseSnapshot) { "PC release baseline plus Android official-server bridge" } else { "live PC source" }
Write-Host "Android listener parity OK: target=$parityTarget, PC payload v$version, payload files=$($entries.Count), source-critical files=$($sharedFiles.Count), client=$($clientContract.versionName)/$($clientContract.patchVersion), kernel TCP normal-play path."
