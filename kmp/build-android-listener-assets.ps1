param(
  [switch]$IncludeGameplayJsons,
  [switch]$IncludeGameplayTables,
  [switch]$IncludeLargeServerData,
  [switch]$IncludeSteamManagedCombatHost,
  [switch]$IncludeAndroidDotnetRuntime,
  [string]$CounterSideManagedDir = "",
  [string]$CounterSideAndroidSplitApk = "",
  [string]$AndroidDotnetRuntimeDir = "",
  [string]$AndroidScriptBundle = "",
  [string]$AndroidPatchInfo = "",
  [string]$AndroidLuaCacheZip = "",
  [string]$AndroidLuaCacheManifest = "",
  [string]$AndroidClientPayloadManifest = "",
  [string]$AndroidClientCdnBaseUrl = "",
  [string]$AndroidClientPayloadManifestUrl = "",
  [switch]$AllowAdbLoopbackCdn,
  [string[]]$PayloadZip = @(),
  [string]$PayloadManifest = ""
)

$ErrorActionPreference = "Stop"

$kmpRoot = Resolve-Path -LiteralPath $PSScriptRoot
$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$assetRoot = Join-Path $kmpRoot "app\src\main\assets\revivalside-listener"
$assetRootFull = [System.IO.Path]::GetFullPath($assetRoot)
$expectedPrefix = [System.IO.Path]::GetFullPath((Join-Path $kmpRoot "app\src\main\assets"))
$payloadAssetZip = Join-Path $expectedPrefix "revivalside-payload.zip"
$payloadAssetManifest = Join-Path $expectedPrefix "revivalside-payload-manifest.json"
$platformAssetManifest = Join-Path $expectedPrefix "revivalside-platform-manifest.json"
$androidClientContract = Join-Path $expectedPrefix "revivalside-android-client-contract.json"
$androidLuaCacheAssetZip = Join-Path $expectedPrefix "revivalside-android-lua-cache.zip"
$gameplayTablesAssetZip = Join-Path $expectedPrefix "revivalside-gameplay-tables.zip"
$gameplayTablesAssetManifest = Join-Path $expectedPrefix "revivalside-gameplay-tables-manifest.json"
$legacyClientAssetRoot = Join-Path $expectedPrefix "revivalside-client-assets"
$officialBridgePatcher = Join-Path $repoRoot "tools\patch-android-official-server-bridge.js"
$scriptBundle = ""
$androidPatchInfoPath = ""
$hasPayload = $PayloadZip.Count -gt 0
$includeManagedCombatHostAssets = $IncludeSteamManagedCombatHost -or $hasPayload
$includeAndroidDotnetRuntimeAssets = $IncludeAndroidDotnetRuntime -or $hasPayload
$includeGameplayTablesAssets = $IncludeGameplayTables -or $hasPayload
$androidCombatRuntimes = @(
  [pscustomobject]@{ Rid = "android-arm64"; Abi = "arm64-v8a"; Clang = "aarch64-linux-android26-clang.cmd"; HostLibrary = "libhostfxr.so" },
  [pscustomobject]@{ Rid = "android-arm"; Abi = "armeabi-v7a"; Clang = "armv7a-linux-androideabi26-clang.cmd"; HostLibrary = "libmonosgen-2.0.so" }
)

if (-not $assetRootFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside Android assets: $assetRootFull"
}

if (-not (Test-Path -LiteralPath $officialBridgePatcher -PathType Leaf)) {
  throw "Android official-server bridge patcher is missing: $officialBridgePatcher"
}

function Write-AndroidPayloadArchive([string[]]$SourcePaths, [string]$DestinationPath) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $destinationStream = [System.IO.File]::Open($DestinationPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  $copied = 0
  $entryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  try {
    $destination = New-Object System.IO.Compression.ZipArchive($destinationStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($sourcePath in $SourcePaths) {
        $source = [System.IO.Compression.ZipFile]::OpenRead($sourcePath)
        try {
          foreach ($entry in $source.Entries) {
            if ([string]::IsNullOrEmpty($entry.Name) -or
                -not $entry.FullName.StartsWith("payload/app/", [System.StringComparison]::OrdinalIgnoreCase) -or
                $entry.FullName.Equals("payload/app/.env", [System.StringComparison]::OrdinalIgnoreCase)) {
              continue
            }
            if (-not $entryNames.Add($entry.FullName)) {
              throw "Duplicate Android payload entry $($entry.FullName) in $sourcePath"
            }
            $outputEntry = $destination.CreateEntry($entry.FullName, [System.IO.Compression.CompressionLevel]::Optimal)
            $outputEntry.LastWriteTime = $entry.LastWriteTime
            $input = $entry.Open()
            try {
              $output = $outputEntry.Open()
              try {
                if ($entry.FullName.Equals("payload/app/server/listener.js", [System.StringComparison]::OrdinalIgnoreCase)) {
                  $temporaryListener = Join-Path ([System.IO.Path]::GetTempPath()) "revivalside-android-listener-$([guid]::NewGuid().ToString('N')).js"
                  try {
                    $temporaryStream = [System.IO.File]::Create($temporaryListener)
                    try { $input.CopyTo($temporaryStream) } finally { $temporaryStream.Dispose() }
                    & node $officialBridgePatcher $temporaryListener | Write-Host
                    if ($LASTEXITCODE -ne 0) { throw "Failed to add the Android official-server bridge to the PC release listener." }
                    $patchedListener = [System.IO.File]::ReadAllBytes($temporaryListener)
                    $output.Write($patchedListener, 0, $patchedListener.Length)
                  } finally {
                    Remove-Item -LiteralPath $temporaryListener -Force -ErrorAction SilentlyContinue
                  }
                } else {
                  $input.CopyTo($output)
                }
              } finally { $output.Dispose() }
            } finally {
              $input.Dispose()
            }
            $copied += 1
          }
        } finally {
          $source.Dispose()
        }
      }
    } finally {
      $destination.Dispose()
    }
  } finally {
    $destinationStream.Dispose()
  }
  if ($copied -eq 0) {
    throw "Payload archives do not contain payload/app files: $($SourcePaths -join ', ')"
  }
  return $copied
}

Remove-Item -LiteralPath $payloadAssetZip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $payloadAssetManifest -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $platformAssetManifest -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $gameplayTablesAssetZip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $gameplayTablesAssetManifest -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $androidLuaCacheAssetZip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $legacyClientAssetRoot -Recurse -Force -ErrorAction SilentlyContinue
if ($AndroidScriptBundle -or $AndroidPatchInfo) {
  if (-not $AndroidScriptBundle -or -not $AndroidPatchInfo) {
    throw "AndroidScriptBundle and AndroidPatchInfo must be provided together."
  }
  $scriptBundle = (Resolve-Path -LiteralPath $AndroidScriptBundle).Path
  $androidPatchInfoPath = (Resolve-Path -LiteralPath $AndroidPatchInfo).Path
  if ([System.IO.Path]::GetFileName($scriptBundle) -cne "ab_script") {
    throw "Android script bundle must keep the encrypted file name ab_script: $scriptBundle"
  }
}

if (-not $hasPayload) {
  throw "Android builds require the PC release core and game-data component archives via -PayloadZip, plus -PayloadManifest."
}

if (-not $PayloadManifest) {
  throw "PayloadManifest is required so Android cannot ship with a listener version different from the PC release."
}

if (-not $AndroidClientPayloadManifest -or -not $AndroidClientCdnBaseUrl) {
  throw "AndroidClientPayloadManifest and AndroidClientCdnBaseUrl are required so the patched client and hosted assets stay version-aligned."
}
if (-not $AndroidLuaCacheZip -or -not $AndroidLuaCacheManifest) {
  throw "AndroidLuaCacheZip and AndroidLuaCacheManifest are required to avoid repeated Lua bundle loads during initialization."
}
$androidLuaCacheZipPath = (Resolve-Path -LiteralPath $AndroidLuaCacheZip).Path
$androidLuaCacheManifestPath = (Resolve-Path -LiteralPath $AndroidLuaCacheManifest).Path
$androidLuaCache = Get-Content -LiteralPath $androidLuaCacheManifestPath -Raw | ConvertFrom-Json
if ($androidLuaCache.schemaVersion -ne 1 -or
    $androidLuaCache.version -notmatch '^ExtraAsset_\d+$' -or
    @($androidLuaCache.files).Count -eq 0 -or
    "counter-pass-always-unlocked" -notin @($androidLuaCache.clientParityPatches) -or
    "operator-contract-category" -notin @($androidLuaCache.clientParityPatches)) {
  throw "Android Lua cache manifest is missing its compatibility contract: $androidLuaCacheManifestPath"
}
$clientPayloadManifestPath = (Resolve-Path -LiteralPath $AndroidClientPayloadManifest).Path
$clientPayloadManifest = Get-Content -LiteralPath $clientPayloadManifestPath -Raw | ConvertFrom-Json
if ($clientPayloadManifest.schemaVersion -ne 1 -or
    -not $clientPayloadManifest.id -or
    -not $clientPayloadManifest.packageName -or
    -not $clientPayloadManifest.versionName -or
    -not $clientPayloadManifest.versionCode -or
    -not $clientPayloadManifest.patchVersion -or
    [long]$clientPayloadManifest.fileCount -le 0 -or
    [long]$clientPayloadManifest.totalBytes -le 0) {
  throw "Android client payload manifest is missing its compatibility contract: $clientPayloadManifestPath"
}
$clientCdn = $AndroidClientCdnBaseUrl.TrimEnd('/') + '/'
if ($clientCdn -notmatch '^https?://') { throw "AndroidClientCdnBaseUrl must be an HTTP(S) URL." }
$clientCdnUri = [Uri]$clientCdn
if ($clientCdnUri.IsLoopback -and $clientCdnUri.Port -ne 8088 -and -not $AllowAdbLoopbackCdn) {
  throw "Loopback AndroidClientCdnBaseUrl must use the embedded listener on port 8088, not $($clientCdnUri.Port)."
}
if (-not $AndroidClientPayloadManifestUrl) {
  $clientRootPath = $clientCdnUri.AbsolutePath -replace '/(?:android-)?patchfiles/?$', '/'
  $AndroidClientPayloadManifestUrl = ([Uri]::new($clientCdnUri, $clientRootPath + 'android-client/payload-manifest.json')).AbsoluteUri
}
$officialServerInfoBase = "https://ctsglobal-cdndown.sbside.com/server_config/live/"
$patchedServerInfoBase = "http://127.0.0.1:8088/revivalsideapk/server_config/live/"
if ($officialServerInfoBase.Length -ne $patchedServerInfoBase.Length) { throw "Android client endpoint patch is not fixed-width." }
$clientContractValue = [ordered]@{
  schemaVersion = 1
  packageName = "$($clientPayloadManifest.packageName)"
  versionName = "$($clientPayloadManifest.versionName)"
  versionCode = [long]$clientPayloadManifest.versionCode
  patchVersion = "$($clientPayloadManifest.patchVersion)"
  localHttpPort = 8088
  metadataEntry = "assets/bin/Data/Managed/Metadata/global-metadata.dat"
  originalServerInfoBaseUrl = $officialServerInfoBase
  patchedServerInfoBaseUrl = $patchedServerInfoBase
  assetCdnBaseUrl = $clientCdn
  payloadManifestUrl = $AndroidClientPayloadManifestUrl
  payloadManifestSha256 = (Get-FileHash -LiteralPath $clientPayloadManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  payloadId = "$($clientPayloadManifest.id)"
  payloadFileCount = [long]$clientPayloadManifest.fileCount
  payloadTotalBytes = [long]$clientPayloadManifest.totalBytes
}
$clientContractJson = $clientContractValue | ConvertTo-Json
[System.IO.File]::WriteAllText($androidClientContract, $clientContractJson + "`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Android client contract staged for $($clientContractValue.versionName) / $($clientContractValue.patchVersion) at $clientCdn"

$payloadZipPaths = @($PayloadZip | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
$manifestPath = (Resolve-Path -LiteralPath $PayloadManifest).Path
$sourceManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$packageVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
if ($sourceManifest.releaseTag -ne "v$packageVersion" -or $sourceManifest.payloadId -ne "revivalside-v$packageVersion") {
  throw "PC payload version mismatch: package=$packageVersion releaseTag=$($sourceManifest.releaseTag) payloadId=$($sourceManifest.payloadId)"
}
$manifestComponents = @($sourceManifest.components.PSObject.Properties.Value | ForEach-Object { $_ })
foreach ($payloadZipPath in $payloadZipPaths) {
  $component = $manifestComponents | Where-Object name -eq (Split-Path -Leaf $payloadZipPath) | Select-Object -First 1
  if (-not $component) { throw "Payload archive is not listed in ${manifestPath}: $payloadZipPath" }
  $actualHash = (Get-FileHash -LiteralPath $payloadZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne "$($component.sha256)".ToLowerInvariant()) {
    throw "PC component hash mismatch for $payloadZipPath"
  }
}

$selectedComponentIds = @($payloadZipPaths | ForEach-Object {
  $name = Split-Path -Leaf $_
  ($manifestComponents | Where-Object name -eq $name | Select-Object -First 1).id
})
foreach ($componentId in @("core", "game-data")) {
  if ($componentId -notin $selectedComponentIds) {
    throw "Android payload requires the exact PC $componentId component from $manifestPath"
  }
}

$copiedPayloadFiles = Write-AndroidPayloadArchive $payloadZipPaths $payloadAssetZip
$payloadHash = (Get-FileHash -LiteralPath $payloadAssetZip -Algorithm SHA256).Hash.ToLowerInvariant()
$payloadSize = (Get-Item -LiteralPath $payloadAssetZip).Length
$payloadId = "$($sourceManifest.payloadId)-android"
[ordered]@{
  schemaVersion = 1
  payloadId = $payloadId
  sourcePayloadId = "$($sourceManifest.payloadId)"
  releaseTag = "$($sourceManifest.releaseTag)"
  archiveName = "revivalside-payload.zip"
  archiveSize = $payloadSize
  archiveSha256 = $payloadHash
} | ConvertTo-Json | Set-Content -LiteralPath $payloadAssetManifest -Encoding UTF8
Write-Host "Android payload staged from the PC core + game-data components with the official-server bridge compatibility route at $payloadAssetZip ($copiedPayloadFiles files, $payloadSize bytes)."

if (Test-Path -LiteralPath $assetRootFull) {
  Remove-Item -LiteralPath $assetRootFull -Recurse -Force
}
New-Item -ItemType Directory -Path $assetRootFull -Force | Out-Null

function Get-RepoRelativePath([string]$FullName) {
  $full = [System.IO.Path]::GetFullPath($FullName)
  $root = [System.IO.Path]::GetFullPath($repoRoot)
  if (-not $root.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $root += [System.IO.Path]::DirectorySeparatorChar
  }
  if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside repo root: $full"
  }
  return $full.Substring($root.Length)
}

function Resolve-CounterSideManagedDir {
  $programFilesX86 = ${env:ProgramFiles(x86)}
  $programFiles = $env:ProgramFiles
  $candidates = @(
    $CounterSideManagedDir,
    $env:CS_COUNTERSIDE_MANAGED_DIR,
    $env:COUNTERSIDE_MANAGED_DIR,
    $env:CS_COUNTERSIDE_DIR,
    "C:\Main\Gaming\Steam\steamapps\common\CounterSide",
    $(if ($programFilesX86) { Join-Path $programFilesX86 "Steam\steamapps\common\CounterSide" }),
    $(if ($programFiles) { Join-Path $programFiles "Steam\steamapps\common\CounterSide" })
  ) | Where-Object { $_ -and $_.Trim() }

  foreach ($candidate in $candidates) {
    $normalized = $candidate.Trim().Trim('"')
    $possible = @($normalized, (Join-Path $normalized "Data\Managed"), (Join-Path $normalized "Managed"))
    foreach ($item in $possible) {
      if (Test-Path -LiteralPath (Join-Path $item "Assembly-CSharp.dll")) {
        return (Resolve-Path -LiteralPath $item).Path
      }
    }
  }

  return ""
}

function Copy-SteamManagedCombatHost {
  if (-not $includeManagedCombatHostAssets) {
    return
  }

  $managedSource = Resolve-CounterSideManagedDir
  if (-not $managedSource) {
    throw "CounterSide Data\Managed with Assembly-CSharp.dll was not found. Pass -CounterSideManagedDir or set CS_COUNTERSIDE_MANAGED_DIR."
  }

  $managedDestination = Join-Path $assetRootFull "combat-managed\Data\Managed"
  New-Item -ItemType Directory -Path $managedDestination -Force | Out-Null
  $copiedManaged = 0
  Get-ChildItem -LiteralPath $managedSource -File -Force | Where-Object {
    $_.Extension -ieq ".dll"
  } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $managedDestination $_.Name) -Force
    $copiedManaged += 1
  }

  $dataSource = Split-Path -Parent $managedSource
  $desktopLua = Join-Path $dataSource "Plugins\x86_64\lua54.dll"
  if (Test-Path -LiteralPath $desktopLua) {
    $desktopLuaDestination = Join-Path $assetRootFull "combat-managed\Data\Plugins\x86_64\lua54.dll"
    New-Item -ItemType Directory -Path (Split-Path -Parent $desktopLuaDestination) -Force | Out-Null
    Copy-Item -LiteralPath $desktopLua -Destination $desktopLuaDestination -Force
  }

  $copiedAndroidLua = 0
  if ($CounterSideAndroidSplitApk) {
    $splitApk = (Resolve-Path -LiteralPath $CounterSideAndroidSplitApk).Path
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($splitApk)
    try {
      foreach ($entry in $zip.Entries) {
        if ($entry.FullName -notmatch '^lib/([^/]+)/liblua54\.so$') {
          continue
        }
        $abi = $Matches[1]
        $destination = Join-Path $assetRootFull "combat-managed\Data\Plugins\$abi\liblua54.so"
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
        $jniDestination = Join-Path $kmpRoot "app\src\main\jniLibs\$abi\liblua54.so"
        New-Item -ItemType Directory -Path (Split-Path -Parent $jniDestination) -Force | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $jniDestination, $true)
        $copiedAndroidLua += 1
      }
    } finally {
      $zip.Dispose()
    }
  }

  Write-Host "CounterSide desktop managed combat assemblies staged from $managedSource ($copiedManaged dlls)."
  if ($copiedAndroidLua -gt 0) {
    Write-Host "CounterSide Android lua native libraries staged from $CounterSideAndroidSplitApk ($copiedAndroidLua ABIs)."
  } else {
    Write-Host "No CounterSide Android split APK provided; Android managed host may still need liblua54.so for this device ABI."
  }
}

function Resolve-AndroidDotnetRuntimeDir([string]$Rid) {
  $runtime = $androidCombatRuntimes | Where-Object Rid -eq $Rid | Select-Object -First 1
  if ($AndroidDotnetRuntimeDir) {
    $resolved = (Resolve-Path -LiteralPath (Join-Path $AndroidDotnetRuntimeDir $Rid)).Path
    if (-not (Test-Path -LiteralPath (Join-Path $resolved $runtime.HostLibrary))) {
      throw "Android dotnet runtime directory does not contain $($runtime.HostLibrary): $resolved"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $resolved "CombatHost.dll"))) {
      throw "Android dotnet runtime directory does not contain CombatHost.dll: $resolved"
    }
    return $resolved
  }

  $runtimeRoot = Join-Path $repoRoot "prebuilt\android-combat-host-runtime\$Rid"
  $runtimeRootFull = [System.IO.Path]::GetFullPath($runtimeRoot)
  $projectPath = Join-Path $repoRoot "combat-host\CombatHost.csproj"
  Write-Host "Publishing $Rid self-contained combat host runtime to $runtimeRootFull"
  $publishArguments = @("publish", $projectPath, "-c", "Release", "-r", $Rid, "--self-contained", "true", "--nologo", "-o", $runtimeRootFull, "-p:DebugType=None", "-p:DebugSymbols=false")
  if ($Rid -eq "android-arm") { $publishArguments += "-p:UseMonoRuntime=true" }
  & dotnet @publishArguments | Write-Host
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish $Rid failed with exit code $LASTEXITCODE"
  }
  return $runtimeRootFull
}

function Copy-AndroidDotnetRuntime {
  if (-not $includeAndroidDotnetRuntimeAssets) {
    return
  }

  foreach ($runtime in $androidCombatRuntimes) {
    $runtimeSource = Resolve-AndroidDotnetRuntimeDir $runtime.Rid
    $runtimeDestination = Join-Path $assetRootFull "combat-runtime\$($runtime.Rid)"
    $nativeRuntimeDestination = Join-Path $kmpRoot "app\src\main\jniLibs\$($runtime.Abi)"
    New-Item -ItemType Directory -Path $runtimeDestination -Force | Out-Null
    New-Item -ItemType Directory -Path $nativeRuntimeDestination -Force | Out-Null

    $copied = 0
    $copiedNative = 0
    $bytes = 0L
    $nativeLibraries = [System.Collections.Generic.List[string]]::new()
    Get-ChildItem -LiteralPath $runtimeSource -File -Force | Where-Object {
      $_.Extension -notin @(".a", ".pdb")
    } | ForEach-Object {
      if ($_.Extension -ieq ".so") {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $nativeRuntimeDestination $_.Name) -Force
        $nativeLibraries.Add($_.Name)
        $copiedNative += 1
      } else {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runtimeDestination $_.Name) -Force
        $copied += 1
        $bytes += $_.Length
      }
    }
    $nativeManifest = Join-Path $runtimeDestination "native-libraries.txt"
    [System.IO.File]::WriteAllText(
      $nativeManifest,
      ((@($nativeLibraries | Sort-Object) -join "`n") + "`n"),
      [System.Text.UTF8Encoding]::new($false)
    )

    Write-Host "$($runtime.Rid) dotnet combat runtime staged from $runtimeSource ($copied files, $bytes bytes)."
    Write-Host "$($runtime.Abi) dotnet native libraries staged at $nativeRuntimeDestination ($copiedNative shared libraries)."
  }
}

function Ensure-AndroidLuaLibraries {
  if (-not $includeManagedCombatHostAssets) { return }

  $missing = @($androidCombatRuntimes | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $kmpRoot "app\src\main\jniLibs\$($_.Abi)\liblua54.so") -PathType Leaf)
  })

  if ($missing.Count -gt 0) {
    $luaArchive = Join-Path $env:TEMP "lua-5.4.4.tar.gz"
    $luaSource = Join-Path $env:TEMP "revivalside-lua-5.4.4\lua-5.4.4\src"
    $expectedHash = "164c7849653b80ae67bec4b7473b884bf5cc8d2dca05653475ec2ed27b9ebf61"
    if (-not (Test-Path -LiteralPath $luaArchive -PathType Leaf) -or
        (Get-FileHash -LiteralPath $luaArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
      Invoke-WebRequest -Uri "https://www.lua.org/ftp/lua-5.4.4.tar.gz" -OutFile $luaArchive
    }
    if ((Get-FileHash -LiteralPath $luaArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
      throw "Lua 5.4.4 source archive hash mismatch: $luaArchive"
    }
    if (-not (Test-Path -LiteralPath $luaSource -PathType Container)) {
      $luaExtractRoot = Split-Path -Parent (Split-Path -Parent $luaSource)
      New-Item -ItemType Directory -Path $luaExtractRoot -Force | Out-Null
      & "$env:SystemRoot\System32\tar.exe" -xzf $luaArchive -C $luaExtractRoot
      if ($LASTEXITCODE -ne 0) { throw "Lua 5.4.4 source extraction failed with exit code $LASTEXITCODE" }
    }

    $sdkRoot = $env:ANDROID_HOME
    if (-not $sdkRoot) {
      $sdkProperty = Get-Content -LiteralPath (Join-Path $kmpRoot "local.properties") |
        Where-Object { $_.StartsWith("sdk.dir=") } | Select-Object -First 1
      if ($sdkProperty) {
        $sdkRoot = $sdkProperty.Substring(8).Replace('\:', ':').Replace('\\', '\')
      }
    }
    if (-not $sdkRoot) { throw "Android SDK was not found. Set ANDROID_HOME or create kmp/local.properties." }
    $ndkRoot = Get-ChildItem -LiteralPath (Join-Path $sdkRoot "ndk") -Directory |
      Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $ndkRoot) { throw "Android NDK was not found under $sdkRoot" }
    $clangRoot = Join-Path $ndkRoot.FullName "toolchains\llvm\prebuilt\windows-x86_64\bin"
    $luaSources = @(Get-ChildItem -LiteralPath $luaSource -Filter "*.c" |
      Where-Object { $_.Name -notin @("lua.c", "luac.c", "onelua.c") } | ForEach-Object FullName)

    foreach ($runtime in $missing) {
      $destination = Join-Path $kmpRoot "app\src\main\jniLibs\$($runtime.Abi)\liblua54.so"
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
      & (Join-Path $clangRoot $runtime.Clang) -fPIC -O2 -shared -DLUA_USE_LINUX '-Wl,-soname,liblua54.so' '-Wl,-z,max-page-size=16384' '-Wl,-z,common-page-size=16384' -o $destination @luaSources -lm -ldl
      if ($LASTEXITCODE -ne 0) { throw "Lua 5.4.4 build for $($runtime.Abi) failed with exit code $LASTEXITCODE" }
    }
  }

  foreach ($runtime in $androidCombatRuntimes) {
    $source = Join-Path $kmpRoot "app\src\main\jniLibs\$($runtime.Abi)\liblua54.so"
    $destination = Join-Path $assetRootFull "combat-managed\Data\Plugins\$($runtime.Abi)\liblua54.so"
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
}

function Add-ZipEntryFromFile(
  [System.IO.Compression.ZipArchive]$Zip,
  [string]$SourcePath,
  [string]$EntryName
) {
  $entry = $Zip.CreateEntry($EntryName.Replace('\', '/'), [System.IO.Compression.CompressionLevel]::Optimal)
  $entry.LastWriteTime = [System.IO.File]::GetLastWriteTime($SourcePath)
  $sourceStream = [System.IO.File]::OpenRead($SourcePath)
  try {
    $entryStream = $entry.Open()
    try {
      $sourceStream.CopyTo($entryStream)
    } finally {
      $entryStream.Dispose()
    }
  } finally {
    $sourceStream.Dispose()
  }
}

function Write-GameplayTablesArchive {
  if (-not $includeGameplayTablesAssets) {
    return
  }

  $sourceRoot = Join-Path $repoRoot "gameplay-tables"
  if (-not (Test-Path -LiteralPath $sourceRoot)) {
    throw "Missing gameplay-tables directory: $sourceRoot"
  }

  foreach ($requiredStageTable in @(
    "StreamingAssets\ab_script\luac\LUA_STAGE_TEMPLET.luac",
    "Assetbundles\ab_script\luac\LUA_STAGE_TEMPLET.luac"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $requiredStageTable) -PathType Leaf)) {
      throw "gameplay-tables does not contain required stage table: $requiredStageTable"
    }
  }

  $contentsVersion = ""
  foreach ($relativeVersionPath in @(
    "Assetbundles\ab_script\luac\LUA_CONTENTS_VERSION.luac",
    "StreamingAssets\ab_script\luac\LUA_CONTENTS_VERSION.luac"
  )) {
    $versionPath = Join-Path $sourceRoot $relativeVersionPath
    if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) { continue }
    $versionBytes = [System.IO.File]::ReadAllBytes($versionPath)
    $versionText = [System.Text.Encoding]::GetEncoding(28591).GetString($versionBytes)
    $markerOffset = $versionText.IndexOf("ContentsVersion", [System.StringComparison]::Ordinal)
    if ($markerOffset -lt 0) { continue }
    $windowLength = [Math]::Min(128, $versionText.Length - $markerOffset)
    $versionMatch = [regex]::Match(
      $versionText.Substring($markerOffset, $windowLength),
      '\b\d{1,4}\.\d{1,4}\.[A-Za-z0-9_-]{1,16}\b'
    )
    if ($versionMatch.Success) {
      $contentsVersion = $versionMatch.Value
      break
    }
  }
  if (-not $contentsVersion) {
    throw "gameplay-tables does not contain a readable LUA_CONTENTS_VERSION.luac"
  }

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipStream = [System.IO.File]::Open($gameplayTablesAssetZip, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  $copied = 0
  $bytes = 0L
  try {
    $zip = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force | Where-Object {
        $_.Extension -ieq ".luac" -or $_.Name -ieq "catalog.json"
      } | ForEach-Object {
        $relative = Get-RepoRelativePath $_.FullName
        Add-ZipEntryFromFile $zip $_.FullName $relative
        $copied += 1
        $bytes += $_.Length
      }
    } finally {
      $zip.Dispose()
    }
  } finally {
    $zipStream.Dispose()
  }

  $sha256 = (Get-FileHash -LiteralPath $gameplayTablesAssetZip -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest = [ordered]@{
    payloadId = "revivalside-gameplay-tables"
    contentsVersion = $contentsVersion
    archiveSha256 = $sha256
    files = $copied
    uncompressedBytes = $bytes
    requiredFile = "gameplay-tables/StreamingAssets/ab_script/luac/LUA_STAGE_TEMPLET.luac"
  } | ConvertTo-Json
  Set-Content -LiteralPath $gameplayTablesAssetManifest -Value ($manifest + "`n") -Encoding UTF8
  Write-Host "Android gameplay table bytecode archive staged at $gameplayTablesAssetZip ($copied files, $bytes bytes, contents=$contentsVersion, sha256=$sha256)."
}

function Copy-CombatHostSourceIntoAssets {
  $sourceRoot = Join-Path $repoRoot "combat-host"
  $destinationRoot = Join-Path $assetRootFull "combat-host"
  New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
  Get-ChildItem -LiteralPath $sourceRoot -File | Where-Object {
    $_.Extension -ieq ".cs" -or $_.Extension -ieq ".csproj"
  } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destinationRoot $_.Name) -Force
  }
}

function Deduplicate-AndroidDotnetRuntimeAssets {
  $arm = Join-Path $assetRootFull "combat-runtime\android-arm"
  $arm64 = Join-Path $assetRootFull "combat-runtime\android-arm64"
  $common = Join-Path $assetRootFull "combat-runtime\common"
  New-Item -ItemType Directory -Path $common -Force | Out-Null
  $deduplicated = 0
  $bytes = 0L
  Get-ChildItem -LiteralPath $arm64 -File -Force | ForEach-Object {
    $other = Join-Path $arm $_.Name
    if ((Test-Path -LiteralPath $other -PathType Leaf) -and
        (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -eq
        (Get-FileHash -LiteralPath $other -Algorithm SHA256).Hash) {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $common $_.Name) -Force
      Remove-Item -LiteralPath $_.FullName -Force
      Remove-Item -LiteralPath $other -Force
      $deduplicated += 1
      $bytes += $_.Length
    }
  }
  Write-Host "Shared Android dotnet runtime files deduplicated ($deduplicated files, $bytes bytes saved from the APK)."
}

function Write-PlatformManifest {
  $records = Get-ChildItem -LiteralPath $assetRootFull -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($assetRootFull.Length).TrimStart('\', '/').Replace('\', '/')
    "$relative|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
  $treeHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
  [ordered]@{
    schemaVersion = 1
    platformId = "revivalside-android-platform-$($treeHash.Substring(0, 12))"
    treeSha256 = $treeHash
    requiredFile = "combat-managed/Data/Managed/Assembly-CSharp.dll"
  } | ConvertTo-Json | Set-Content -LiteralPath $platformAssetManifest -Encoding UTF8
  Write-Host "Android-only platform assets staged with tree sha256=$treeHash."
}

if ($IncludeGameplayJsons -or $IncludeLargeServerData) {
  throw "Gameplay JSON and server-data diagnostics must be added to the shared PC payload; Android no longer accepts a second listener overlay."
}

Copy-CombatHostSourceIntoAssets
if ($scriptBundle) {
  $clientAssetRoot = Join-Path $assetRootFull "server-data\android-client-update"
  New-Item -ItemType Directory -Path $clientAssetRoot -Force | Out-Null
  Copy-Item -LiteralPath $scriptBundle -Destination (Join-Path $clientAssetRoot "ab_script") -Force
  Copy-Item -LiteralPath $androidPatchInfoPath -Destination (Join-Path $clientAssetRoot "LatestPatchInfo.json") -Force
  $tutorialResourcesPath = Join-Path (Split-Path -Parent $androidPatchInfoPath) "tutorialDungeonResources.json"
  if (Test-Path -LiteralPath $tutorialResourcesPath -PathType Leaf) {
    Copy-Item -LiteralPath $tutorialResourcesPath -Destination (Join-Path $clientAssetRoot "tutorialDungeonResources.json") -Force
  }
  $expectedLuaCacheVersion = "$($clientPayloadManifest.patchVersion)" -replace '^ANDROID_', 'ExtraAsset_'
  if ($androidLuaCache.version -ne $expectedLuaCacheVersion) {
    throw "Android Lua cache version mismatch: expected=$expectedLuaCacheVersion actual=$($androidLuaCache.version)"
  }
  Write-Host "Android Lua cache parity validated; the complete imported/external payload serves it without duplicating 285+ MB in the APK."
  Write-Host "CounterSide Android asset-manager update staged at $clientAssetRoot."
}
Copy-SteamManagedCombatHost
Ensure-AndroidLuaLibraries
Copy-AndroidDotnetRuntime
Deduplicate-AndroidDotnetRuntimeAssets
Write-GameplayTablesArchive

foreach ($requiredPath in @("combat-managed\Data\Managed\Assembly-CSharp.dll", "combat-host\CombatHost.csproj") + @($androidCombatRuntimes | ForEach-Object {
  "combat-runtime\$($_.Rid)\CombatHost.dll"
  "combat-runtime\$($_.Rid)\native-libraries.txt"
})) {
  if (-not (Test-Path -LiteralPath (Join-Path $assetRootFull $requiredPath) -PathType Leaf)) {
    throw "Standalone Android payload is missing required platform asset: $requiredPath"
  }
}
foreach ($runtime in $androidCombatRuntimes) {
  $nativeHost = Join-Path $kmpRoot "app\src\main\jniLibs\$($runtime.Abi)\$($runtime.HostLibrary)"
  if (-not (Test-Path -LiteralPath $nativeHost -PathType Leaf)) {
    throw "Standalone Android payload is missing required native combat host: $nativeHost"
  }
}
if (-not (Test-Path -LiteralPath $gameplayTablesAssetZip -PathType Leaf)) {
  throw "Standalone Android payload is missing required gameplay asset: revivalside-gameplay-tables.zip"
}
Write-PlatformManifest

Write-Host "Android platform assets staged at $assetRootFull"
