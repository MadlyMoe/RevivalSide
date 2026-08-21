param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [string]$OutputDirectory = "",
  [string]$ContractPath = "",
  [string]$AndroidSdk = "",
  [string]$ApktoolJar = "",
  [string]$Keystore = "",
  [string]$KeyAlias = "androiddebugkey",
  [string]$KeystorePassword = "android",
  [string]$KeyPassword = "android"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$input = Resolve-Path -LiteralPath $InputPath
if (-not $ContractPath) { $ContractPath = Join-Path $repoRoot "kmp\app\src\main\assets\revivalside-android-client-contract.json" }
$contractFile = Resolve-Path -LiteralPath $ContractPath
$contract = Get-Content -LiteralPath $contractFile -Raw | ConvertFrom-Json
if ($contract.schemaVersion -ne 1) { throw "Unsupported Android client contract: $contractFile" }
if ([string]$contract.originalServerInfoBaseUrl -eq [string]$contract.patchedServerInfoBaseUrl) { throw "Client endpoint patch has no change." }
if ([string]$contract.originalServerInfoBaseUrl.Length -ne [string]$contract.patchedServerInfoBaseUrl.Length) {
  throw "Client endpoint patch is not fixed-width."
}

if (-not $ApktoolJar) {
  $apktoolDirectory = Join-Path $repoRoot "prebuilt\android-tools\apktool-3.0.3"
  $ApktoolJar = Join-Path $apktoolDirectory "apktool_3.0.3.jar"
  if (-not (Test-Path -LiteralPath $ApktoolJar)) {
    New-Item -ItemType Directory -Path $apktoolDirectory -Force | Out-Null
    Invoke-WebRequest -Uri "https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar" -OutFile $ApktoolJar
  }
}
$apktoolFile = Resolve-Path -LiteralPath $ApktoolJar
$apktoolSha256 = (Get-FileHash -LiteralPath $apktoolFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($apktoolSha256 -ne "dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423") {
  throw "Unexpected Apktool 3.0.3 SHA-256: $apktoolSha256"
}
$java = Get-Command java -ErrorAction Stop

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $repoRoot "prebuilt\counterside-android-patched\$($contract.versionName)"
}
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null

if (-not $AndroidSdk) {
  $AndroidSdk = $env:ANDROID_HOME
  if (-not $AndroidSdk) { $AndroidSdk = $env:ANDROID_SDK_ROOT }
  if (-not $AndroidSdk) {
    $properties = Join-Path $repoRoot "kmp\local.properties"
    if (Test-Path -LiteralPath $properties) {
      $sdkLine = Get-Content -LiteralPath $properties | Where-Object { $_ -match '^sdk\.dir=' } | Select-Object -First 1
      if ($sdkLine) { $AndroidSdk = ($sdkLine -replace '^sdk\.dir=', '') -replace '\\:', ':' -replace '\\\\', '\' }
    }
  }
}
if (-not $AndroidSdk -or -not (Test-Path -LiteralPath $AndroidSdk)) { throw "Android SDK was not found. Pass -AndroidSdk." }
$buildTools = Get-ChildItem -LiteralPath (Join-Path $AndroidSdk "build-tools") -Directory |
  Where-Object { (Test-Path -LiteralPath (Join-Path $_.FullName "apksigner.bat")) -and (Test-Path -LiteralPath (Join-Path $_.FullName "zipalign.exe")) } |
  Sort-Object { [version]($_.Name -replace '-.*$', '') } -Descending |
  Select-Object -First 1
if (-not $buildTools) { throw "Android SDK build-tools with apksigner and zipalign were not found." }
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
$zipalign = Join-Path $buildTools.FullName "zipalign.exe"

if (-not $Keystore) {
  $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $Keystore = Join-Path $userProfile ".android\debug.keystore"
}
$keystoreFile = Resolve-Path -LiteralPath $Keystore

$temporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$workRoot = Join-Path $temporaryParent ("revivalside-android-patch-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
try {
  $sourceRoot = Join-Path $workRoot "source"
  New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
  if ((Get-Item -LiteralPath $input).PSIsContainer) {
    Get-ChildItem -LiteralPath $input -Filter *.apk -File | Copy-Item -Destination $sourceRoot
  } else {
    if ([System.IO.Path]::GetExtension($input).ToLowerInvariant() -notin @(".xapk", ".zip")) {
      throw "Input must be an XAPK/ZIP or a directory containing split APKs."
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($input, $sourceRoot)
  }

  $apks = @(Get-ChildItem -LiteralPath $sourceRoot -Filter *.apk -File -Recurse)
  if ($apks.Count -eq 0) { throw "No APK files were found in $input" }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $baseApk = $null
  foreach ($apk in $apks) {
    $probe = [System.IO.Compression.ZipFile]::OpenRead($apk.FullName)
    try {
      if ($probe.GetEntry([string]$contract.metadataEntry)) { $baseApk = $apk; break }
    } finally { $probe.Dispose() }
  }
  if (-not $baseApk) { throw "No APK contains $($contract.metadataEntry)." }

  $zip = [System.IO.Compression.ZipFile]::Open($baseApk.FullName, [System.IO.Compression.ZipArchiveMode]::Update)
  try {
    $entry = $zip.GetEntry([string]$contract.metadataEntry)
    $memory = New-Object System.IO.MemoryStream
    $sourceStream = $entry.Open()
    try {
      $sourceStream.CopyTo($memory)
      $metadata = $memory.ToArray()
    } finally {
      $sourceStream.Dispose()
      $memory.Dispose()
    }
    $before = [System.Text.Encoding]::UTF8.GetBytes([string]$contract.originalServerInfoBaseUrl)
    $after = [System.Text.Encoding]::UTF8.GetBytes([string]$contract.patchedServerInfoBaseUrl)
    $matches = @()
    $patchedMatches = @()
    for ($offset = 0; $offset -le $metadata.Length - $before.Length; $offset++) {
      $equal = $true
      $patchedEqual = $true
      for ($index = 0; $index -lt $before.Length; $index++) {
        if ($metadata[$offset + $index] -ne $before[$index]) { $equal = $false; break }
      }
      for ($index = 0; $index -lt $after.Length; $index++) {
        if ($metadata[$offset + $index] -ne $after[$index]) { $patchedEqual = $false; break }
      }
      if ($equal) { $matches += $offset; $offset += $before.Length - 1 }
      elseif ($patchedEqual) { $patchedMatches += $offset; $offset += $after.Length - 1 }
    }
    if ($matches.Count -eq 1 -and $patchedMatches.Count -eq 0) {
      [System.Array]::Copy($after, 0, $metadata, $matches[0], $after.Length)
      $entry.Delete()
      $replacement = $zip.CreateEntry([string]$contract.metadataEntry, [System.IO.Compression.CompressionLevel]::Optimal)
      $stream = $replacement.Open()
      try { $stream.Write($metadata, 0, $metadata.Length) } finally { $stream.Dispose() }
    } elseif ($matches.Count -ne 0 -or $patchedMatches.Count -ne 1) {
      throw "Expected one official or already-patched ServerInfo endpoint in IL2CPP metadata; found official=$($matches.Count) patched=$($patchedMatches.Count)."
    }
  } finally { $zip.Dispose() }

  # Gamebase obtains the same ServerInfo URL dynamically and passes it to Unity in
  # LaunchingInfo JSON. Override only that serialization boundary so Gamebase's
  # status/version checks continue to run unchanged.
  $decodedBase = Join-Path $workRoot "decoded-base"
  & $java.Source -jar $apktoolFile d -f -r $baseApk.FullName -o $decodedBase
  if ($LASTEXITCODE -ne 0) { throw "Apktool failed to decode $($baseApk.Name)." }
  $launchingInfoFiles = @(Get-ChildItem -LiteralPath $decodedBase -Recurse -Filter "LaunchingInfo.smali" -File |
    Where-Object { $_.FullName -match '[\\/]com[\\/]toast[\\/]android[\\/]gamebase[\\/]launching[\\/]data[\\/]LaunchingInfo\.smali$' })
  if ($launchingInfoFiles.Count -ne 1) {
    throw "Expected one Gamebase LaunchingInfo.smali; found $($launchingInfoFiles.Count)."
  }
  $launchingInfo = $launchingInfoFiles[0].FullName
  $launchingSmali = [System.IO.File]::ReadAllText($launchingInfo)
  $launchingOverride = @"

.method public toJsonString()Ljava/lang/String;
    .locals 3

    invoke-super {p0}, Lcom/toast/android/gamebase/base/ValueObject;->toJsonString()Ljava/lang/String;
    move-result-object v0

    const-string v1, "$($contract.originalServerInfoBaseUrl)"
    const-string v2, "$($contract.patchedServerInfoBaseUrl)"
    invoke-virtual {v0, v1, v2}, Ljava/lang/String;->replace(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Ljava/lang/String;
    move-result-object v0

    return-object v0
.end method
"@
  if ($launchingSmali -notmatch '(?m)^\.method public toJsonString\(\)Ljava/lang/String;$') {
    [System.IO.File]::AppendAllText($launchingInfo, $launchingOverride, [System.Text.UTF8Encoding]::new($false))
  }

  # CounterSide does not promote LatestPatchInfo.json when every file is already
  # present. Promote that verified manifest before Unity starts so the complete
  # asset index becomes the persistent cache instead of being reloaded forever.
  $customActivityFiles = @(Get-ChildItem -LiteralPath $decodedBase -Recurse -Filter "CustomActivity.smali" -File |
    Where-Object { $_.FullName -match '[\\/]com[\\/]studiobside[\\/]CounterSide[\\/]CustomActivity\.smali$' })
  if ($customActivityFiles.Count -ne 1) {
    throw "Expected one CounterSide CustomActivity.smali; found $($customActivityFiles.Count)."
  }
  $customActivity = $customActivityFiles[0].FullName
  $customActivitySmali = [System.IO.File]::ReadAllText($customActivity)
  if ($customActivitySmali -notmatch 'RevivalSideManifestCache;->promote') {
    if ($customActivitySmali -match '(?m)^\.method protected onCreate\(Landroid/os/Bundle;\)V$') {
      throw "CounterSide CustomActivity already overrides onCreate; the manifest cache hook must be reviewed."
    }
    $activityOverride = @"

.method protected onCreate(Landroid/os/Bundle;)V
    .locals 0

    invoke-static {p0}, Lcom/studiobside/CounterSide/RevivalSideManifestCache;->promote(Landroid/content/Context;)V
    invoke-super {p0, p1}, Lcom/toast/android/gamebase/activity/GamebaseMainActivity;->onCreate(Landroid/os/Bundle;)V
    return-void
.end method
"@
    [System.IO.File]::AppendAllText($customActivity, $activityOverride, [System.Text.UTF8Encoding]::new($false))
  }
  $manifestCacheSmali = Join-Path $customActivityFiles[0].DirectoryName "RevivalSideManifestCache.smali"
  $manifestCacheBody = @'
.class public final Lcom/studiobside/CounterSide/RevivalSideManifestCache;
.super Ljava/lang/Object;
.source "RevivalSideManifestCache.java"

.method public static promote(Landroid/content/Context;)V
    .locals 7

    :try_start
    const/4 v0, 0x0
    invoke-virtual {p0, v0}, Landroid/content/Context;->getExternalFilesDir(Ljava/lang/String;)Ljava/io/File;
    move-result-object v0
    if-eqz v0, :done

    new-instance v1, Ljava/io/File;
    const-string v2, "Assetbundles/LatestPatchInfo.json"
    invoke-direct {v1, v0, v2}, Ljava/io/File;-><init>(Ljava/io/File;Ljava/lang/String;)V
    invoke-virtual {v1}, Ljava/io/File;->isFile()Z
    move-result v2
    if-eqz v2, :done

    new-instance v2, Ljava/io/File;
    const-string v3, "Assetbundles/PatchInfo.json"
    invoke-direct {v2, v0, v3}, Ljava/io/File;-><init>(Ljava/io/File;Ljava/lang/String;)V
    new-instance v3, Ljava/io/File;
    const-string v4, "Assetbundles/PatchInfo.json.revivalside"
    invoke-direct {v3, v0, v4}, Ljava/io/File;-><init>(Ljava/io/File;Ljava/lang/String;)V

    invoke-virtual {v1}, Ljava/io/File;->toPath()Ljava/nio/file/Path;
    move-result-object v1
    invoke-virtual {v3}, Ljava/io/File;->toPath()Ljava/nio/file/Path;
    move-result-object v0
    const/4 v4, 0x1
    new-array v4, v4, [Ljava/nio/file/CopyOption;
    const/4 v5, 0x0
    sget-object v6, Ljava/nio/file/StandardCopyOption;->REPLACE_EXISTING:Ljava/nio/file/StandardCopyOption;
    aput-object v6, v4, v5
    invoke-static {v1, v0, v4}, Ljava/nio/file/Files;->copy(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)Ljava/nio/file/Path;

    invoke-virtual {v2}, Ljava/io/File;->toPath()Ljava/nio/file/Path;
    move-result-object v1
    const/4 v2, 0x2
    new-array v2, v2, [Ljava/nio/file/CopyOption;
    const/4 v3, 0x0
    sget-object v4, Ljava/nio/file/StandardCopyOption;->REPLACE_EXISTING:Ljava/nio/file/StandardCopyOption;
    aput-object v4, v2, v3
    const/4 v3, 0x1
    sget-object v4, Ljava/nio/file/StandardCopyOption;->ATOMIC_MOVE:Ljava/nio/file/StandardCopyOption;
    aput-object v4, v2, v3
    invoke-static {v0, v1, v2}, Ljava/nio/file/Files;->move(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)Ljava/nio/file/Path;

    const-string v0, "RevivalSide"
    const-string v1, "Promoted verified Android asset manifest cache"
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I
    :try_end
    .catch Ljava/lang/Exception; {:try_start .. :try_end} :catch
    goto :done

    :catch
    move-exception v0
    const-string v1, "RevivalSide"
    const-string v2, "Android asset manifest cache promotion skipped"
    invoke-static {v1, v2, v0}, Landroid/util/Log;->w(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)I

    :done
    return-void
.end method

.method public static promoteLater(Landroid/content/Context;)V
    .locals 4

    new-instance v0, Landroid/os/Handler;
    invoke-static {}, Landroid/os/Looper;->getMainLooper()Landroid/os/Looper;
    move-result-object v1
    invoke-direct {v0, v1}, Landroid/os/Handler;-><init>(Landroid/os/Looper;)V

    new-instance v1, Lcom/studiobside/CounterSide/RevivalSideManifestCache$1;
    invoke-direct {v1, p0}, Lcom/studiobside/CounterSide/RevivalSideManifestCache$1;-><init>(Landroid/content/Context;)V

    const-wide/16 v2, 0x3e8
    invoke-virtual {v0, v1, v2, v3}, Landroid/os/Handler;->postDelayed(Ljava/lang/Runnable;J)Z
    return-void
.end method
'@
  [System.IO.File]::WriteAllText($manifestCacheSmali, $manifestCacheBody, [System.Text.UTF8Encoding]::new($false))
  $manifestCacheRunnableSmali = Join-Path $customActivityFiles[0].DirectoryName 'RevivalSideManifestCache$1.smali'
  $manifestCacheRunnableBody = @'
.class final Lcom/studiobside/CounterSide/RevivalSideManifestCache$1;
.super Ljava/lang/Object;
.source "RevivalSideManifestCache.java"

.implements Ljava/lang/Runnable;

.field private final context:Landroid/content/Context;

.method constructor <init>(Landroid/content/Context;)V
    .locals 0
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
    iput-object p1, p0, Lcom/studiobside/CounterSide/RevivalSideManifestCache$1;->context:Landroid/content/Context;
    return-void
.end method

.method public run()V
    .locals 3
    iget-object v0, p0, Lcom/studiobside/CounterSide/RevivalSideManifestCache$1;->context:Landroid/content/Context;
    invoke-static {v0}, Lcom/studiobside/CounterSide/RevivalSideManifestCache;->promote(Landroid/content/Context;)V

    new-instance v0, Ljava/lang/Thread;
    new-instance v1, Lcom/studiobside/CounterSide/RevivalSideManifestCache$2;
    invoke-direct {v1}, Lcom/studiobside/CounterSide/RevivalSideManifestCache$2;-><init>()V
    const-string v2, "RevivalSideLobbyWarmup"
    invoke-direct {v0, v1, v2}, Ljava/lang/Thread;-><init>(Ljava/lang/Runnable;Ljava/lang/String;)V
    invoke-virtual {v0}, Ljava/lang/Thread;->start()V
    return-void
.end method
'@
  [System.IO.File]::WriteAllText($manifestCacheRunnableSmali, $manifestCacheRunnableBody, [System.Text.UTF8Encoding]::new($false))
  $manifestCacheWarmupSmali = Join-Path $customActivityFiles[0].DirectoryName 'RevivalSideManifestCache$2.smali'
  $manifestCacheWarmupBody = @'
.class final Lcom/studiobside/CounterSide/RevivalSideManifestCache$2;
.super Ljava/lang/Object;
.source "RevivalSideManifestCache.java"

.implements Ljava/lang/Runnable;

.method constructor <init>()V
    .locals 0
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
    return-void
.end method

.method public run()V
    .locals 4

    :try_start
    new-instance v0, Ljava/net/URL;
    const-string v1, "http://127.0.0.1:8088/launcher/api/warmup"
    invoke-direct {v0, v1}, Ljava/net/URL;-><init>(Ljava/lang/String;)V
    invoke-virtual {v0}, Ljava/net/URL;->openConnection()Ljava/net/URLConnection;
    move-result-object v0
    check-cast v0, Ljava/net/HttpURLConnection;

    const-string v1, "POST"
    invoke-virtual {v0, v1}, Ljava/net/HttpURLConnection;->setRequestMethod(Ljava/lang/String;)V
    const/16 v1, 0x1388
    invoke-virtual {v0, v1}, Ljava/net/HttpURLConnection;->setConnectTimeout(I)V
    const v1, 0x1d4c0
    invoke-virtual {v0, v1}, Ljava/net/HttpURLConnection;->setReadTimeout(I)V
    invoke-virtual {v0}, Ljava/net/HttpURLConnection;->getResponseCode()I
    move-result v1
    invoke-virtual {v0}, Ljava/net/HttpURLConnection;->disconnect()V

    const-string v0, "RevivalSide"
    new-instance v2, Ljava/lang/StringBuilder;
    invoke-direct {v2}, Ljava/lang/StringBuilder;-><init>()V
    const-string v3, "Lobby warmup after asset download: HTTP "
    invoke-virtual {v2, v3}, Ljava/lang/StringBuilder;->append(Ljava/lang/String;)Ljava/lang/StringBuilder;
    invoke-virtual {v2, v1}, Ljava/lang/StringBuilder;->append(I)Ljava/lang/StringBuilder;
    invoke-virtual {v2}, Ljava/lang/StringBuilder;->toString()Ljava/lang/String;
    move-result-object v1
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I
    :try_end
    .catch Ljava/lang/Exception; {:try_start .. :try_end} :catch
    goto :done

    :catch
    move-exception v0
    const-string v1, "RevivalSide"
    const-string v2, "Lobby warmup after asset download skipped"
    invoke-static {v1, v2, v0}, Landroid/util/Log;->w(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)I

    :done
    return-void
.end method
'@
  [System.IO.File]::WriteAllText($manifestCacheWarmupSmali, $manifestCacheWarmupBody, [System.Text.UTF8Encoding]::new($false))

  # Unity writes its selected-language PatchInfo immediately after the Java
  # service finishes. Promote the complete verified manifest one second later,
  # after that write, so subsequent boots skip the multi-gigabyte integrity pass.
  $downloadServiceRunnableFiles = @(Get-ChildItem -LiteralPath $decodedBase -Recurse -Filter 'DownloadService$1.smali' -File |
    Where-Object { $_.FullName -match '[\\/]com[\\/]studiobside[\\/]nkaservice[\\/]DownloadService\$1\.smali$' })
  if ($downloadServiceRunnableFiles.Count -ne 1) {
    throw "Expected one CounterSide download-service worker; found $($downloadServiceRunnableFiles.Count)."
  }
  $downloadServiceRunnable = $downloadServiceRunnableFiles[0].FullName
  $downloadServiceRunnableBody = [System.IO.File]::ReadAllText($downloadServiceRunnable)
  if ($downloadServiceRunnableBody -notmatch 'RevivalSideManifestCache;->promoteLater') {
    $downloadCompletePattern = '(?m)^    invoke-static \{v0\}, Lcom/studiobside/nkaservice/DownloadService;->access\$200\(Lcom/studiobside/nkaservice/DownloadService;\)V\r?\n\r?\n    \.line 97\r?$'
    if ([regex]::Matches($downloadServiceRunnableBody, $downloadCompletePattern).Count -ne 1) {
      throw "Expected one CounterSide download-completion insertion point."
    }
    $downloadCompleteReplacement = @'
    invoke-static {v0}, Lcom/studiobside/nkaservice/DownloadService;->access$200(Lcom/studiobside/nkaservice/DownloadService;)V

    iget-object v0, p0, Lcom/studiobside/nkaservice/DownloadService$1;->this$0:Lcom/studiobside/nkaservice/DownloadService;
    invoke-static {v0}, Lcom/studiobside/CounterSide/RevivalSideManifestCache;->promoteLater(Landroid/content/Context;)V

    .line 97
'@
    $downloadServiceRunnableBody = [regex]::Replace(
      $downloadServiceRunnableBody,
      $downloadCompletePattern,
      [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $downloadCompleteReplacement },
      1
    )
  }
  [System.IO.File]::WriteAllText($downloadServiceRunnable, $downloadServiceRunnableBody, [System.Text.UTF8Encoding]::new($false))

  # The sideloaded Global build receives only Gamebase's unpublished test SKU,
  # which makes Unity hide every real Admin Coin card. Replace that display-only
  # catalog with the matching SKUs already built into this exact client version.
  $adminCoinPrices = [ordered]@{
    2351 = 0.99; 2352 = 6.99; 2353 = 19.99; 2354 = 34.99; 2355 = 49.99; 2356 = 79.99
    2357 = 0.99; 2358 = 6.99; 2359 = 19.99; 2360 = 34.99; 2361 = 49.99; 2362 = 79.99
    2363 = 4.99; 2364 = 10.49; 2365 = 4.99; 2366 = 10.49; 2367 = 4.49; 2368 = 43.99
  }
  $adminCoinItems = @($adminCoinPrices.GetEnumerator() | ForEach-Object {
    [ordered]@{
      currency = "USD"
      gamebaseProductId = [string]$_.Key
      isActive = $true
      itemName = "Admin Coin"
      itemSeq = [long]$_.Key
      localizedDescription = "Admin Coin package"
      localizedPrice = '$' + ([double]$_.Value).ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
      localizedTitle = "Admin Coin"
      marketItemId = [string]$_.Key
      price = [double]$_.Value
      productType = "CONSUMABLE"
    }
  })
  $adminCoinJson = ConvertTo-Json -InputObject $adminCoinItems -Compress -Depth 4
  $adminCoinSmaliJson = $adminCoinJson.Replace('\', '\\').Replace('"', '\"')
  $purchasePluginFiles = @(Get-ChildItem -LiteralPath $decodedBase -Recurse -Filter "GamebasePurchasePlugin.smali" -File |
    Where-Object { $_.FullName -match '[\\/]com[\\/]toast[\\/]android[\\/]gamebase[\\/]plugin[\\/]GamebasePurchasePlugin\.smali$' })
  if ($purchasePluginFiles.Count -ne 1) {
    throw "Expected one GamebasePurchasePlugin.smali; found $($purchasePluginFiles.Count)."
  }
  $purchasePlugin = $purchasePluginFiles[0].FullName
  $purchaseSmali = [System.IO.File]::ReadAllText($purchasePlugin)
  $purchaseMethodPattern = '(?s)\.method static synthetic lambda\$requestItemListPurchasable\$5\(Lcom/toast/android/gamebase/plugin/communicator/GamebaseListener;Ljava/lang/String;Lcom/toast/android/gamebase/plugin/communicator/message/EngineMessage;Ljava/util/List;Lcom/toast/android/gamebase/base/GamebaseException;\)V.*?\.end method'
  $purchaseMatches = [regex]::Matches($purchaseSmali, $purchaseMethodPattern)
  if ($purchaseMatches.Count -ne 1) {
    throw "Expected one Gamebase purchasable-list callback; found $($purchaseMatches.Count)."
  }
  $purchaseOverride = @"
.method static synthetic lambda`$requestItemListPurchasable`$5(Lcom/toast/android/gamebase/plugin/communicator/GamebaseListener;Ljava/lang/String;Lcom/toast/android/gamebase/plugin/communicator/message/EngineMessage;Ljava/util/List;Lcom/toast/android/gamebase/base/GamebaseException;)V
    .locals 6

    const-string v4, "$adminCoinSmaliJson"
    const/4 v3, 0x0

    new-instance v0, Lcom/toast/android/gamebase/plugin/communicator/message/NativeMessage;
    iget-object v1, p2, Lcom/toast/android/gamebase/plugin/communicator/message/EngineMessage;->scheme:Ljava/lang/String;
    iget v2, p2, Lcom/toast/android/gamebase/plugin/communicator/message/EngineMessage;->handle:I
    const/4 v5, 0x0
    invoke-direct/range {v0 .. v5}, Lcom/toast/android/gamebase/plugin/communicator/message/NativeMessage;-><init>(Ljava/lang/String;ILcom/toast/android/gamebase/base/GamebaseException;Ljava/lang/String;Ljava/lang/String;)V
    invoke-interface {p0, p1, v0}, Lcom/toast/android/gamebase/plugin/communicator/GamebaseListener;->onSendMessage(Ljava/lang/String;Lcom/toast/android/gamebase/plugin/communicator/message/NativeMessage;)V
    return-void
.end method
"@
  $purchaseSmali = [regex]::Replace(
    $purchaseSmali,
    $purchaseMethodPattern,
    [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $purchaseOverride },
    1
  )
  [System.IO.File]::WriteAllText($purchasePlugin, $purchaseSmali, [System.Text.UTF8Encoding]::new($false))

  # The stock downloader serializes every asset behind one AtomicBoolean, copies
  # it through a 4 KiB buffer, and logs both queue and dispatch activity. Keep
  # the same file/ACK queues while allowing OkHttp's five same-host workers to
  # operate concurrently and use a 64 KiB buffer per active request.
  $downloaderFiles = @(Get-ChildItem -LiteralPath $decodedBase -Recurse -Filter "HttpClientFileDownloader.smali" -File |
    Where-Object { $_.FullName -match '[\\/]com[\\/]studiobside[\\/]nkadownloader[\\/]HttpClientFileDownloader\.smali$' })
  if ($downloaderFiles.Count -ne 1) {
    throw "Expected one CounterSide HTTP downloader; found $($downloaderFiles.Count)."
  }
  $downloaderFile = $downloaderFiles[0].FullName
  $downloaderSmali = [System.IO.File]::ReadAllText($downloaderFile)
  $downloadCallbackFiles = @(Get-ChildItem -LiteralPath $decodedBase -Recurse -Filter 'HttpClientFileDownloader$1.smali' -File |
    Where-Object { $_.FullName -match '[\\/]com[\\/]studiobside[\\/]nkadownloader[\\/]HttpClientFileDownloader\$1\.smali$' })
  if ($downloadCallbackFiles.Count -ne 1) {
    throw "Expected one CounterSide HTTP downloader callback; found $($downloadCallbackFiles.Count)."
  }
  $downloadCallbackFile = $downloadCallbackFiles[0].FullName
  $downloadCallbackSmali = [System.IO.File]::ReadAllText($downloadCallbackFile)
  $activeFieldAnchor = '.field public _downloadedBytes:Ljava/util/concurrent/atomic/AtomicLong;'
  if (-not $downloaderSmali.Contains('.field private final _activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;')) {
    if ([regex]::Matches($downloaderSmali, [regex]::Escape($activeFieldAnchor)).Count -ne 1) {
      throw "Expected one CounterSide downloader field insertion point."
    }
    $downloaderSmali = $downloaderSmali.Replace(
      $activeFieldAnchor,
      ".field private final _activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;`r`n`r`n$activeFieldAnchor"
    )
  }
  $constructorAnchor = '(?m)^    iput-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_downloadedBytes:Ljava/util/concurrent/atomic/AtomicLong;\r?\n\r?\n    return-void\r?$'
  if ($downloaderSmali -notmatch '(?m)^    iput-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;\r?$') {
    if ([regex]::Matches($downloaderSmali, $constructorAnchor).Count -ne 1) {
      throw "Expected one CounterSide downloader constructor insertion point."
    }
    $fastConstructorTail = @"
    iput-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_downloadedBytes:Ljava/util/concurrent/atomic/AtomicLong;

    new-instance v0, Ljava/util/concurrent/atomic/AtomicInteger;

    invoke-direct {v0}, Ljava/util/concurrent/atomic/AtomicInteger;-><init>()V

    iput-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;

    return-void
"@
    $downloaderSmali = [regex]::Replace($downloaderSmali, $constructorAnchor, $fastConstructorTail, 1)
  }
  $downloadRequestGatePattern = '(?s)(\.method private DownloadRequest\(Lcom/studiobside/nkadownloader/HttpClientFileDownloader\$FileInfo;\)V\r?\n    \.locals 3\r?\n).*?(?=    \.line 134\r?\n)'
  if ($downloaderSmali -notmatch 'AtomicInteger;->incrementAndGet\(\)I') {
    if ([regex]::Matches($downloaderSmali, $downloadRequestGatePattern).Count -ne 1) {
      throw "Expected one stock CounterSide downloader request gate."
    }
    $fastDownloadRequestGate = @"
`$1    iget-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;

    invoke-virtual {v0}, Ljava/util/concurrent/atomic/AtomicInteger;->incrementAndGet()I

    iget-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_downloading:Ljava/util/concurrent/atomic/AtomicBoolean;

    const/4 v1, 0x1

    invoke-virtual {v0, v1}, Ljava/util/concurrent/atomic/AtomicBoolean;->set(Z)V

"@
    $downloaderSmali = [regex]::Replace($downloaderSmali, $downloadRequestGatePattern, $fastDownloadRequestGate, 1)
  }
  $copyBufferPattern = '(?m)^    const/16 v1, 0x1000\r?\n\r?\n    new-array v1, v1, \[B\r?$'
  $fastCopyBuffer = "    const v1, 0x10000`r`n`r`n    new-array v1, v1, [B"
  $copyBufferMatches = [regex]::Matches($downloadCallbackSmali, $copyBufferPattern)
  if ($copyBufferMatches.Count -eq 1) {
    $downloadCallbackSmali = [regex]::Replace($downloadCallbackSmali, $copyBufferPattern, $fastCopyBuffer, 1)
  } elseif ($downloadCallbackSmali -notmatch '(?m)^    const v1, 0x10000\r?\n\r?\n    new-array v1, v1, \[B\r?$') {
    throw "Expected one stock or already-optimized CounterSide downloader copy buffer."
  }
  $finishHelper = @'

.method public OnDownloadFinished()V
    .locals 3

    iget-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;

    invoke-virtual {v0}, Ljava/util/concurrent/atomic/AtomicInteger;->decrementAndGet()I

    move-result v0

    if-nez v0, :done

    iget-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_downloading:Ljava/util/concurrent/atomic/AtomicBoolean;

    const/4 v1, 0x0

    invoke-virtual {v0, v1}, Ljava/util/concurrent/atomic/AtomicBoolean;->set(Z)V

    :done
    return-void
.end method
'@
  if ($downloaderSmali -notmatch '(?m)^\.method public OnDownloadFinished\(\)V\r?$') {
    $virtualMethodsAnchor = "`r`n`r`n# virtual methods`r`n"
    if (-not $downloaderSmali.Contains($virtualMethodsAnchor)) {
      $virtualMethodsAnchor = "`n`n# virtual methods`n"
    }
    if (-not $downloaderSmali.Contains($virtualMethodsAnchor)) {
      throw "Expected CounterSide downloader virtual-method insertion point."
    }
    $downloaderSmali = $downloaderSmali.Replace($virtualMethodsAnchor, "$finishHelper$virtualMethodsAnchor")
  }
  $failureFinishPattern = '(?s)    iget-object p1, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader\$1;->this\$0:Lcom/studiobside/nkadownloader/HttpClientFileDownloader;\r?\n\r?\n    invoke-static \{p1\}, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->access\$100\(Lcom/studiobside/nkadownloader/HttpClientFileDownloader;\)Ljava/util/concurrent/atomic/AtomicBoolean;\r?\n\r?\n    move-result-object p1\r?\n\r?\n    const/4 p2, 0x0\r?\n\r?\n    invoke-virtual \{p1, p2\}, Ljava/util/concurrent/atomic/AtomicBoolean;->set\(Z\)V'
  if ([regex]::Matches($downloadCallbackSmali, $failureFinishPattern).Count -eq 1) {
    $failureFinish = '    iget-object p1, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader$1;->this$0:Lcom/studiobside/nkadownloader/HttpClientFileDownloader;' + "`r`n`r`n" + '    invoke-virtual {p1}, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->OnDownloadFinished()V'
    $downloadCallbackSmali = [regex]::Replace($downloadCallbackSmali, $failureFinishPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $failureFinish }, 1)
  }
  $responseFinishPattern = '(?s)    iget-object p1, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader\$1;->this\$0:Lcom/studiobside/nkadownloader/HttpClientFileDownloader;\r?\n\r?\n    invoke-static \{p1\}, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->access\$100\(Lcom/studiobside/nkadownloader/HttpClientFileDownloader;\)Ljava/util/concurrent/atomic/AtomicBoolean;\r?\n\r?\n    move-result-object p1\r?\n\r?\n    invoke-virtual \{p1, v0\}, Ljava/util/concurrent/atomic/AtomicBoolean;->set\(Z\)V'
  if ([regex]::Matches($downloadCallbackSmali, $responseFinishPattern).Count -eq 1) {
    $responseFinish = '    iget-object p1, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader$1;->this$0:Lcom/studiobside/nkadownloader/HttpClientFileDownloader;' + "`r`n`r`n" + '    invoke-virtual {p1}, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->OnDownloadFinished()V'
    $downloadCallbackSmali = [regex]::Replace($downloadCallbackSmali, $responseFinishPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $responseFinish }, 1)
  }
  if ([regex]::Matches($downloadCallbackSmali, 'OnDownloadFinished\(\)V').Count -ne 2) {
    throw "CounterSide downloader completion accounting is incomplete."
  }
  $activeResetAnchor = '(?m)^    \.line 83\r?\n    iget-object p1, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_downloading:Ljava/util/concurrent/atomic/AtomicBoolean;\r?$'
  if ($downloaderSmali -notmatch '(?s)_activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;\r?\n\r?\n    invoke-virtual \{p1, p2\}, Ljava/util/concurrent/atomic/AtomicInteger;->set\(I\)V') {
    $activeReset = @"
    iget-object p1, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;

    invoke-virtual {p1, p2}, Ljava/util/concurrent/atomic/AtomicInteger;->set(I)V

    .line 83
    iget-object p1, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_downloading:Ljava/util/concurrent/atomic/AtomicBoolean;
"@
    if ([regex]::Matches($downloaderSmali, $activeResetAnchor).Count -ne 1) {
      throw "Expected one CounterSide downloader reset insertion point."
    }
    $downloaderSmali = [regex]::Replace($downloaderSmali, $activeResetAnchor, $activeReset, 1)
  }
  $downloadMethodPattern = '(?s)\.method public Download\(\)V.*?\.end method'
  if ([regex]::Matches($downloaderSmali, $downloadMethodPattern).Count -ne 1) {
    throw "Expected one CounterSide Download method."
  }
  $fastDownloadMethod = @'
.method public Download()V
    .locals 3

    iget-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;
    invoke-virtual {v0}, Ljava/util/concurrent/atomic/AtomicInteger;->get()I
    move-result v0
    const/4 v1, 0x5
    if-lt v0, v1, :has_capacity
    return-void

    :has_capacity
    iget-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_downloadFileQueue:Ljava/util/Queue;
    invoke-interface {v0}, Ljava/util/Queue;->size()I
    move-result v0
    if-nez v0, :dispatch

    iget-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_activeDownloads:Ljava/util/concurrent/atomic/AtomicInteger;
    invoke-virtual {v0}, Ljava/util/concurrent/atomic/AtomicInteger;->get()I
    move-result v0
    if-nez v0, :return

    iget-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_isDone:Ljava/util/concurrent/atomic/AtomicBoolean;
    const/4 v1, 0x1
    invoke-virtual {v0, v1}, Ljava/util/concurrent/atomic/AtomicBoolean;->set(Z)V
    return-void

    :dispatch
    iget-object v0, p0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_downloadFileQueue:Ljava/util/Queue;
    invoke-interface {v0}, Ljava/util/Queue;->poll()Ljava/lang/Object;
    move-result-object v0
    check-cast v0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader$FileInfo;
    invoke-direct {p0, v0}, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->DownloadRequest(Lcom/studiobside/nkadownloader/HttpClientFileDownloader$FileInfo;)V

    :return
    return-void
.end method
'@
  $downloaderSmali = [regex]::Replace($downloaderSmali, $downloadMethodPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $fastDownloadMethod }, 1)
  $addFileLogPattern = '(?ms)^    \.line 95\r?\n    sget-object v0, Lcom/studiobside/nkadownloader/HttpClientFileDownloader;->_tag:Ljava/lang/String;\r?\n.*?^    invoke-static \{v0, v1\}, Landroid/util/Log;->i\(Ljava/lang/String;Ljava/lang/String;\)I\r?\n'
  if ([regex]::Matches($downloaderSmali, $addFileLogPattern).Count -eq 1) {
    $downloaderSmali = [regex]::Replace($downloaderSmali, $addFileLogPattern, "", 1)
  } elseif ($downloaderSmali.Contains('[AddDownloadFile] ')) {
    throw "CounterSide per-file queue logging did not match the expected method body."
  }
  if ($downloaderSmali.Contains('[Download] downloadTarget : ') -or $downloaderSmali.Contains('[Download] downloading ..')) {
    throw "CounterSide per-file dispatch logging remains after fast-method replacement."
  }
  [System.IO.File]::WriteAllText($downloadCallbackFile, $downloadCallbackSmali, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($downloaderFile, $downloaderSmali, [System.Text.UTF8Encoding]::new($false))

  $rebuiltBase = Join-Path $workRoot "base-gamebase-patched.apk"
  & $java.Source -jar $apktoolFile b $decodedBase -o $rebuiltBase
  if ($LASTEXITCODE -ne 0) { throw "Apktool failed to rebuild $($baseApk.Name)." }
  Copy-Item -LiteralPath $rebuiltBase -Destination $baseApk.FullName -Force

  $outputs = @()
  $signedBasePath = ""
  foreach ($apk in $apks) {
    $aligned = Join-Path $workRoot ("aligned-" + $apk.Name)
    $destinationName = if ($apk.FullName -eq $baseApk.FullName) {
      "base.apk"
    } elseif ($apk.Name -match '^config\.(.+)\.apk$') {
      "split_config.$($Matches[1]).apk"
    } else {
      $apk.Name
    }
    $destination = Join-Path $output $destinationName
    & $zipalign -P 16 -f 4 $apk.FullName $aligned
    if ($LASTEXITCODE -ne 0) { throw "zipalign failed for $($apk.Name)." }
    & $apksigner sign --ks $keystoreFile --ks-key-alias $KeyAlias --ks-pass "pass:$KeystorePassword" --key-pass "pass:$KeyPassword" --out $destination $aligned
    if ($LASTEXITCODE -ne 0) { throw "apksigner failed for $($apk.Name)." }
    & $apksigner verify --verbose $destination | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Signature verification failed for $destination." }
    if ($apk.FullName -eq $baseApk.FullName) { $signedBasePath = $destination }
    $outputs += [ordered]@{
      name = $destinationName
      size = (Get-Item -LiteralPath $destination).Length
      sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
      base = $apk.FullName -eq $baseApk.FullName
    }
  }

  $result = [ordered]@{
    schemaVersion = 1
    packageName = [string]$contract.packageName
    versionName = [string]$contract.versionName
    versionCode = [long]$contract.versionCode
    patchVersion = [string]$contract.patchVersion
    patchedServerInfoBaseUrl = [string]$contract.patchedServerInfoBaseUrl
    gamebaseLaunchingResponsePatched = $true
    gamebasePurchasableAdminCoinsReplaced = $true
    assetManifestCachePatched = $true
    assetManifestCachePromotedAfterDownload = $true
    assetDownloadLobbyWarmup = $true
    downloadCopyBufferBytes = 65536
    downloadParallelRequests = 5
    downloadTargetLoggingDisabled = $true
    apktoolVersion = "3.0.3"
    apktoolSha256 = $apktoolSha256
    signingKeySha256 = (& $apksigner verify --print-certs $signedBasePath | Select-String 'Signer #1 certificate SHA-256 digest:' | ForEach-Object { ($_.Line -split ':', 2)[1].Trim() })
    apks = $outputs
  }
  $json = $result | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText((Join-Path $output "patched-client.json"), $json + "`n", [System.Text.UTF8Encoding]::new($false))
  Write-Host "Patched and signed $($outputs.Count) APKs at $output"
  Write-Host "Install together with: adb install-multiple -r $output\*.apk"
  Write-Host "If Android reports a signature mismatch, uninstall the official package first; that erases its app-private data."
} finally {
  $resolvedWork = [System.IO.Path]::GetFullPath($workRoot)
  if ($resolvedWork.StartsWith($temporaryParent, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedWork).StartsWith("revivalside-android-patch-")) {
    Remove-Item -LiteralPath $resolvedWork -Recurse -Force -ErrorAction SilentlyContinue
  }
}
