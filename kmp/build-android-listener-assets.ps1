param(
  [switch]$IncludeGameplayJsons,
  [switch]$IncludeGameplayTables,
  [switch]$IncludeLargeServerData,
  [switch]$IncludeSteamManagedCombatHost,
  [switch]$IncludeAndroidDotnetRuntime,
  [string]$CounterSideManagedDir = "",
  [string]$CounterSideAndroidSplitApk = "",
  [string]$AndroidDotnetRuntimeDir = "",
  [string]$PayloadZip = "",
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
$gameplayTablesAssetZip = Join-Path $expectedPrefix "revivalside-gameplay-tables.zip"
$gameplayTablesAssetManifest = Join-Path $expectedPrefix "revivalside-gameplay-tables-manifest.json"
$includeManagedCombatHostAssets = $IncludeSteamManagedCombatHost -or [bool]$PayloadZip
$includeAndroidDotnetRuntimeAssets = $IncludeAndroidDotnetRuntime -or [bool]$PayloadZip
$includeGameplayTablesAssets = $IncludeGameplayTables -or [bool]$PayloadZip

if (-not $assetRootFull.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside Android assets: $assetRootFull"
}

Remove-Item -LiteralPath $payloadAssetZip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $payloadAssetManifest -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $gameplayTablesAssetZip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $gameplayTablesAssetManifest -Force -ErrorAction SilentlyContinue

if ($PayloadZip) {
  $payloadZipPath = (Resolve-Path -LiteralPath $PayloadZip).Path
  Copy-Item -LiteralPath $payloadZipPath -Destination $payloadAssetZip -Force

  $manifestSource = $PayloadManifest
  if (-not $manifestSource) {
    $candidate = Join-Path (Split-Path -Parent $payloadZipPath) "RevivalSidePayloadManifest.json"
    if (Test-Path -LiteralPath $candidate) {
      $manifestSource = $candidate
    }
  }
  if ($manifestSource) {
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $manifestSource).Path -Destination $payloadAssetManifest -Force
  }
  Write-Host "Android payload archive staged at $payloadAssetZip"
  if (Test-Path -LiteralPath $payloadAssetManifest) {
    Write-Host "Android payload manifest staged at $payloadAssetManifest"
  } else {
    Write-Host "Android payload manifest not provided; extraction will use package install markers only."
  }
}

if (Test-Path -LiteralPath $assetRootFull) {
  Remove-Item -LiteralPath $assetRootFull -Recurse -Force
}
New-Item -ItemType Directory -Path $assetRootFull -Force | Out-Null

function Copy-FileIntoAssets([string]$RelativePath) {
  $source = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Missing required listener file: $source"
  }
  $destination = Join-Path $assetRootFull $RelativePath
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

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

function Should-SkipPath([System.IO.FileSystemInfo]$Item) {
  $relative = (Get-RepoRelativePath $Item.FullName).Replace('\', '/')
  if ($relative -match '(^|/)node_modules($|/)') { return $true }
  if ($relative -match '(^|/)logs($|/)') { return $true }
  if ($relative -match '(^|/)captures($|/)') { return $true }
  if ($relative -match '(^|/)exports($|/)') { return $true }
  if ($relative -match '(^|/)users\.json$') { return $true }
  if ($relative -match '(^|/)users-[0-9].*\.json$') { return $true }
  if ($relative -match '(^|/)server-time\.json$') { return $true }
  if ($relative -match '(^|/)combat-host/bin/host-cache($|/)') { return $true }
  if ($relative -match '(^|/)combat-host/bin/Debug($|/)') { return $true }
  if ($relative -match '(^|/)combat-host/bin/Release/net8\.0/(android|linux|osx|win)-[^/]+($|/)') { return $true }
  if ($relative -match '(^|/)combat-host/obj($|/)') { return $true }
  if ($relative -match '(^|/)patched-managed($|/)') { return $true }
  return $false
}

function Copy-DirectoryIntoAssets([string]$RelativePath) {
  $sourceRoot = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $sourceRoot)) {
    throw "Missing required listener directory: $sourceRoot"
  }
  Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force | ForEach-Object {
    if (-not (Should-SkipPath $_)) {
      $relative = Get-RepoRelativePath $_.FullName
      $destination = Join-Path $assetRootFull $relative
      if ($_.PSIsContainer) {
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
      } else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
      }
    }
  }
}

function Copy-ServerDataIntoAssets {
  $serverDataFiles = @(
    ".gitkeep",
    "README.md",
    "dungeons.json",
    "items.json",
    "starter-users.json",
    "table_catalog.json",
    "units.json",
    "warfare.json",
    "new-account-defaults.json"
  )
  foreach ($fileName in $serverDataFiles) {
    $relative = Join-Path "server-data" $fileName
    $source = Join-Path $repoRoot $relative
    if (Test-Path -LiteralPath $source) {
      Copy-FileIntoAssets $relative
    }
  }

  if ($IncludeLargeServerData) {
    Copy-FileIntoAssets "server-data\strings.json"
  }
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

function Get-CombatHostSourceStamp([string]$CombatHostDir) {
  $hasher = [System.Security.Cryptography.IncrementalHash]::CreateHash([System.Security.Cryptography.HashAlgorithmName]::SHA1)
  $utf8 = [System.Text.Encoding]::UTF8
  $zero = [byte[]](0)
  $files = Get-ChildItem -LiteralPath $CombatHostDir -File |
    Where-Object { $_.Name.EndsWith(".cs", [System.StringComparison]::OrdinalIgnoreCase) -or $_.Name.EndsWith(".csproj", [System.StringComparison]::OrdinalIgnoreCase) } |
    Sort-Object Name
  foreach ($file in $files) {
    $hasher.AppendData($utf8.GetBytes($file.Name))
    $hasher.AppendData($zero)
    $hasher.AppendData([System.IO.File]::ReadAllBytes($file.FullName))
    $hasher.AppendData($zero)
  }
  return ([System.BitConverter]::ToString($hasher.GetHashAndReset()).Replace("-", "").ToLowerInvariant()).Substring(0, 16)
}

function Resolve-AndroidDotnetRuntimeDir {
  if ($AndroidDotnetRuntimeDir) {
    $resolved = (Resolve-Path -LiteralPath $AndroidDotnetRuntimeDir).Path
    if (-not (Test-Path -LiteralPath (Join-Path $resolved "libhostfxr.so"))) {
      throw "Android dotnet runtime directory does not contain libhostfxr.so: $resolved"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $resolved "CombatHost.dll"))) {
      throw "Android dotnet runtime directory does not contain CombatHost.dll: $resolved"
    }
    return $resolved
  }

  $runtimeRoot = Join-Path $repoRoot "prebuilt\android-combat-host-runtime\android-arm64"
  $runtimeRootFull = [System.IO.Path]::GetFullPath($runtimeRoot)
  $projectPath = Join-Path $repoRoot "combat-host\CombatHost.csproj"
  Write-Host "Publishing Android arm64 self-contained combat host runtime to $runtimeRootFull"
  & dotnet publish $projectPath -c Release -r android-arm64 --self-contained true --nologo -o $runtimeRootFull -p:DebugType=None -p:DebugSymbols=false | Write-Host
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish android-arm64 failed with exit code $LASTEXITCODE"
  }
  return $runtimeRootFull
}

function Copy-AndroidDotnetRuntime {
  if (-not $includeAndroidDotnetRuntimeAssets) {
    return
  }

  $runtimeSource = Resolve-AndroidDotnetRuntimeDir
  $runtimeDestination = Join-Path $assetRootFull "combat-runtime\android-arm64"
  $nativeRuntimeDestination = Join-Path $kmpRoot "app\src\main\jniLibs\arm64-v8a"
  New-Item -ItemType Directory -Path $runtimeDestination -Force | Out-Null
  New-Item -ItemType Directory -Path $nativeRuntimeDestination -Force | Out-Null

  $copied = 0
  $copiedNative = 0
  $bytes = 0L
  Get-ChildItem -LiteralPath $runtimeSource -File -Force | Where-Object {
    $_.Extension -notin @(".a", ".pdb")
  } | ForEach-Object {
    $destination = Join-Path $runtimeDestination $_.Name
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    $copied += 1
    $bytes += $_.Length
    if ($_.Extension -ieq ".so") {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $nativeRuntimeDestination $_.Name) -Force
      $copiedNative += 1
    }
  }

  Write-Host "Android dotnet combat runtime staged from $runtimeSource ($copied files, $bytes bytes)."
  Write-Host "Android dotnet native libraries staged at $nativeRuntimeDestination ($copiedNative shared libraries)."

  $sourceCombatHost = Join-Path $repoRoot "combat-host"
  $stamp = Get-CombatHostSourceStamp $sourceCombatHost
  $hostCacheDestination = Join-Path $assetRootFull "combat-host\bin\host-cache\$stamp"
  if (Test-Path -LiteralPath $hostCacheDestination) {
    Remove-Item -LiteralPath $hostCacheDestination -Recurse -Force
  }
  New-Item -ItemType Directory -Path $hostCacheDestination -Force | Out-Null
  $copiedCache = 0
  Get-ChildItem -LiteralPath $runtimeSource -File -Force | Where-Object {
    $_.Extension -notin @(".a", ".pdb")
  } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $hostCacheDestination $_.Name) -Force
    $copiedCache += 1
  }
  foreach ($required in @("CombatHost.dll", "CombatHost.deps.json", "CombatHost.runtimeconfig.json")) {
    $requiredPath = Join-Path $hostCacheDestination $required
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Android CombatHost project-cache output is missing $requiredPath"
    }
  }
  Write-Host "Android CombatHost original project layout: source + host-cache\$stamp ($copiedCache files)."
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
    archiveSha256 = $sha256
    files = $copied
    uncompressedBytes = $bytes
    requiredFile = "gameplay-tables/StreamingAssets/ab_script/luac/LUA_STAGE_TEMPLET.luac"
  } | ConvertTo-Json
  Set-Content -LiteralPath $gameplayTablesAssetManifest -Value ($manifest + "`n") -Encoding UTF8
  Write-Host "Android gameplay table bytecode archive staged at $gameplayTablesAssetZip ($copied files, $bytes bytes, sha256=$sha256)."
}

Copy-FileIntoAssets "cs-listener.js"
Copy-FileIntoAssets "package.json"
Copy-FileIntoAssets "packet-schema.json"
Copy-DirectoryIntoAssets "server"
Copy-DirectoryIntoAssets "modules"
Copy-DirectoryIntoAssets "packet-handlers"
Copy-DirectoryIntoAssets "combat-handler"
Copy-DirectoryIntoAssets "combat-host"
Copy-DirectoryIntoAssets "stages"
Copy-ServerDataIntoAssets
Copy-DirectoryIntoAssets "server-data\captured-tcp"
Copy-SteamManagedCombatHost
Copy-AndroidDotnetRuntime
Write-GameplayTablesArchive

if ($PayloadZip) {
  foreach ($requiredPath in @(
    "combat-managed\Data\Managed\Assembly-CSharp.dll",
    "combat-runtime\android-arm64\CombatHost.dll",
    "combat-runtime\android-arm64\libhostfxr.so"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $assetRootFull $requiredPath) -PathType Leaf)) {
      throw "Standalone Android payload is missing required managed combat asset: $requiredPath"
    }
  }
  if (-not (Test-Path -LiteralPath $gameplayTablesAssetZip -PathType Leaf)) {
    throw "Standalone Android payload is missing required managed combat asset: revivalside-gameplay-tables.zip"
  }
}

if ($IncludeGameplayJsons) {
  Copy-DirectoryIntoAssets "gameplay-jsons"
}

Write-Host "Android listener assets staged at $assetRootFull"
Write-Host "Use -PayloadZip for the full standalone release payload with managed combat, -IncludeGameplayTables for combat tables, or -IncludeGameplayJsons / -IncludeLargeServerData only for oversized diagnostic APKs."
