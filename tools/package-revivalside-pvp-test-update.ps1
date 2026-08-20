param(
  [string]$OutputDir = "",
  [string]$LauncherPath = ""
)

$ErrorActionPreference = "Stop"
$rootPath = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $rootPath "prebuilt\pvp-test-update"
}
if ([string]::IsNullOrWhiteSpace($LauncherPath)) {
  $LauncherPath = Join-Path $rootPath "prebuilt\revivalside-relay-local\RevivalSideLauncher.exe"
}
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$LauncherPath = [IO.Path]::GetFullPath($LauncherPath)

function Require-File([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label was not found: $Path"
  }
}

function Copy-RepoFile([string]$RelativePath, [string]$PayloadRoot) {
  $source = Join-Path $rootPath $RelativePath
  Require-File $source $RelativePath
  $destination = Join-Path $PayloadRoot $RelativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Copy-RepoTree([string]$RelativePath, [string]$PayloadRoot) {
  $sourceRoot = Join-Path $rootPath $RelativePath
  if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "$RelativePath was not found: $sourceRoot"
  }
  foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File) {
    Copy-RepoFile $file.FullName.Substring($rootPath.Length + 1) $PayloadRoot
  }
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$Label) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

function Remove-ExactTree([string]$Path, [string]$ExpectedParent) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullParent = [IO.Path]::GetFullPath($ExpectedParent).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($fullParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a path outside the expected parent: $fullPath"
  }
  Remove-Item -LiteralPath $fullPath -Recurse -Force
}

Require-File $LauncherPath "Built RevivalSide launcher"
$launcherSources = @(
  (Join-Path $rootPath "launcher\src\games\revivalside\pages\Home\GameSettings.tsx"),
  (Join-Path $rootPath "launcher\src\lib\launcher-api.ts"),
  (Join-Path $rootPath "launcher\src-tauri\src\lib.rs")
)
$latestLauncherSource = $launcherSources | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } | Sort-Object -Descending | Select-Object -First 1
if ((Get-Item -LiteralPath $LauncherPath).LastWriteTimeUtc -lt $latestLauncherSource) {
  throw "The staged launcher is older than its PvP UI source. Rebuild it before packaging."
}

$dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (-not $dotnet) { $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue }
if (-not $dotnet) { throw "dotnet was not found." }

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stageRoot = Join-Path $OutputDir (".pvp-test-update-" + [Guid]::NewGuid().ToString("N"))
$payloadRoot = Join-Path $stageRoot "payload"
$buildRoot = Join-Path $stageRoot ".build"
$finalFolder = ""
$zipPath = ""
New-Item -ItemType Directory -Force -Path $payloadRoot, $buildRoot | Out-Null

try {
  Write-Host "Staging the PvP runtime delta"
  Copy-Item -LiteralPath $LauncherPath -Destination (Join-Path $payloadRoot "RevivalSideLauncher.exe") -Force

  Copy-RepoFile "cs-listener.js" $payloadRoot
  foreach ($runtimeTree in @("server", "modules", "packet-handlers", "stages", "combat-handler")) {
    Copy-RepoTree $runtimeTree $payloadRoot
  }

  foreach ($relativePath in @(
    "combat-host\CombatEngine.cs",
    "combat-host\ManagedCombatBridge.cs",
    "combat-host\StateModels.cs",
    "tools\revivalside-launcher-backend.js",
    "docs\relay-server.md"
  )) {
    Copy-RepoFile $relativePath $payloadRoot
  }
  Require-File (Join-Path $payloadRoot "modules\gameplay-jsons\index.js") "Listener gameplay-table runtime dependency"
  Require-File (Join-Path $payloadRoot "modules\frozen-client-update\index.js") "Listener Android/frozen-client runtime dependency"

  Write-Host "Publishing the Windows x64 CombatHost"
  $combatOutput = Join-Path $buildRoot "combat-host"
  Invoke-Checked $dotnet.Source @(
    "publish", (Join-Path $rootPath "combat-host\CombatHost.csproj"),
    "-c", "Release", "-r", "win-x64", "--self-contained", "true", "--nologo",
    "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:EnableCompressionInSingleFile=true", "-p:DebugType=None", "-p:DebugSymbols=false", "-o", $combatOutput
  ) "CombatHost publish"
  Get-ChildItem -LiteralPath $combatOutput -File | Where-Object Extension -ne ".pdb" | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $payloadRoot "combat-host") -Force
  }

  Write-Host "Publishing the Friendly Battle client patcher"
  $patcherOutput = Join-Path $buildRoot "patcher"
  Invoke-Checked $dotnet.Source @(
    "publish", (Join-Path $rootPath "tools\CounterPassClientPatcher\CounterPassClientPatcher.csproj"),
    "-c", "Release", "-r", "win-x64", "--self-contained", "true", "--nologo",
    "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:EnableCompressionInSingleFile=true", "-p:DebugType=None", "-p:DebugSymbols=false", "-o", $patcherOutput
  ) "CounterPassClientPatcher publish"
  $patcherDestination = Join-Path $payloadRoot "tools\CounterPassClientPatcher"
  New-Item -ItemType Directory -Force -Path $patcherDestination | Out-Null
  Get-ChildItem -LiteralPath $patcherOutput -File | Where-Object Extension -ne ".pdb" | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $patcherDestination -Force
  }

  Write-Host "Publishing the self-contained Linux x64 relay"
  $relayOutput = Join-Path $buildRoot "relay"
  Invoke-Checked $dotnet.Source @(
    "publish", (Join-Path $rootPath "relay-host\RevivalSideRelay.csproj"),
    "-c", "Release", "-r", "linux-x64", "--self-contained", "true", "--nologo",
    "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:DebugType=None", "-p:DebugSymbols=false", "-o", $relayOutput
  ) "Relay publish"
  $relayBinary = Join-Path $relayOutput "RevivalSideRelay"
  Require-File $relayBinary "Published relay binary"
  $relayDestination = Join-Path $payloadRoot "relay-host\linux-x64"
  New-Item -ItemType Directory -Force -Path $relayDestination | Out-Null
  Copy-Item -LiteralPath $relayBinary -Destination (Join-Path $relayDestination "RevivalSideRelay") -Force

  Write-Host "Smoke-testing the staged listener runtime"
  Invoke-Checked "node" @((Join-Path $rootPath "tools\check-listener-runtime-startup.js"), $payloadRoot) "Staged listener runtime startup"

  $payloadFiles = Get-ChildItem -LiteralPath $payloadRoot -Recurse -File | Sort-Object FullName
  if (-not $payloadFiles.Count) { throw "The PvP update payload is empty." }
  $manifestFiles = foreach ($file in $payloadFiles) {
    $relative = $file.FullName.Substring($payloadRoot.Length + 1).Replace('\', '/')
    [ordered]@{
      path = $relative
      size = [long]$file.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    }
  }
  $fingerprintInput = ($manifestFiles | ForEach-Object { "$($_.path):$($_.sha256)" }) -join "`n"
  $fingerprintBytes = [Text.Encoding]::UTF8.GetBytes($fingerprintInput)
  $fingerprintSha = [Security.Cryptography.SHA256]::Create()
  try {
    $fingerprint = ([BitConverter]::ToString($fingerprintSha.ComputeHash($fingerprintBytes))).Replace("-", "").ToLowerInvariant().Substring(0, 12)
  }
  finally { $fingerprintSha.Dispose() }
  $buildStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $updateId = "revivalside-pvp-relay-test-$buildStamp-$fingerprint"
  $manifest = [ordered]@{
    schemaVersion = 1
    updateId = $updateId
    channel = "private-pvp-relay-test"
    target = "RevivalSide v0.4.0 on Windows x64 or Windows 11 ARM64"
    requiredPackageVersion = "0.4.0"
    createdUtc = (Get-Date).ToUniversalTime().ToString("o")
    files = @($manifestFiles)
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stageRoot "manifest.json") -Encoding UTF8

  $installerTemplate = @'
param(
  [string]$InstallRoot = "",
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $packageRoot "manifest.json"
$payloadRoot = Join-Path $packageRoot "payload"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "RevivalSide"
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')

function Safe-ChildPath([string]$Root, [string]$RelativePath) {
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath)) {
    throw "Unsafe update path: $RelativePath"
  }
  $segments = $RelativePath.Replace('/', '\').Split('\')
  if ($segments -contains ".." -or $segments -contains "." -or $segments -contains "") {
    throw "Unsafe update path: $RelativePath"
  }
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $fullPath = [IO.Path]::GetFullPath((Join-Path $Root ($segments -join '\')))
  if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Update path escapes the RevivalSide installation: $RelativePath"
  }
  return $fullPath
}

function Is-UnderRoot([string]$Candidate, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
  try {
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $fullCandidate = [IO.Path]::GetFullPath($Candidate)
    return $fullCandidate.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)
  }
  catch { return $false }
}

function Find-RunningRevivalSideProcesses([string]$Root) {
  $matches = @()
  try {
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.Name -in @("RevivalSideLauncher.exe", "CounterSide.exe", "CombatHost.exe", "node.exe")
    }
    foreach ($process in $processes) {
      $inside = Is-UnderRoot ([string]$process.ExecutablePath) $Root
      $commandLine = [string]$process.CommandLine
      if (-not $inside -and $commandLine) {
        $inside = $commandLine.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0
      }
      if ($inside) { $matches += "$($process.Name) (PID $($process.ProcessId))" }
    }
  }
  catch {
    foreach ($name in @("RevivalSideLauncher", "CounterSide", "CombatHost", "node")) {
      foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        try {
          if (Is-UnderRoot ([string]$process.Path) $Root) { $matches += "$($process.ProcessName) (PID $($process.Id))" }
        }
        catch { }
      }
    }
  }
  return @($matches | Sort-Object -Unique)
}

try {
  Write-Host "RevivalSide Private PvP Relay Test Update" -ForegroundColor Cyan
  Write-Host "Target: $InstallRoot"

  $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  if ($architecture -notin @("X64", "Arm64")) {
    throw "This test update requires Windows x64 or Windows 11 ARM64 with x64 app support."
  }
  foreach ($required in @("package.json", "RevivalSideLauncher.exe", "server\listener.js", "tools\revivalside-launcher-backend.js")) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $required) -PathType Leaf)) {
      throw "A complete existing RevivalSide installation was not found at $InstallRoot"
    }
  }

  $packageMetadata = Get-Content -LiteralPath (Join-Path $InstallRoot "package.json") -Raw | ConvertFrom-Json
  if ([string]$packageMetadata.version -ne "0.4.0") {
    throw "This update requires RevivalSide v0.4.0. Found: $($packageMetadata.version)"
  }
  $running = Find-RunningRevivalSideProcesses $InstallRoot
  if ($running.Count) {
    throw "Close RevivalSide before updating. Still running: $($running -join ', ')"
  }

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ([int]$manifest.schemaVersion -ne 1 -or -not $manifest.updateId -or -not $manifest.files.Count) {
    throw "The update manifest is invalid."
  }
  $seen = @{}
  foreach ($entry in $manifest.files) {
    $relative = [string]$entry.path
    if ($seen.ContainsKey($relative.ToLowerInvariant())) { throw "Duplicate manifest path: $relative" }
    $seen[$relative.ToLowerInvariant()] = $true
    $source = Safe-ChildPath $payloadRoot $relative
    [void](Safe-ChildPath $InstallRoot $relative)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Payload file is missing: $relative" }
    if ((Get-Item -LiteralPath $source).Length -ne [long]$entry.size) { throw "Payload size check failed: $relative" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Payload hash check failed: $relative" }
  }

  $backupName = "pvp-test-update-$($manifest.updateId)-" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $backupRoot = Safe-ChildPath $InstallRoot (".backups/" + $backupName)
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $changes = @()
  foreach ($entry in $manifest.files) {
    $relative = [string]$entry.path
    $target = Safe-ChildPath $InstallRoot $relative
    $existed = Test-Path -LiteralPath $target -PathType Leaf
    if ($existed) {
      $backup = Safe-ChildPath $backupRoot $relative
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
      Copy-Item -LiteralPath $target -Destination $backup -Force
    }
    $changes += [pscustomobject]@{ path = $relative; existed = $existed }
  }

  $applied = @()
  try {
    foreach ($entry in $manifest.files) {
      $relative = [string]$entry.path
      $source = Safe-ChildPath $payloadRoot $relative
      $target = Safe-ChildPath $InstallRoot $relative
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      $temporary = "$target.pvp-update-$PID.tmp"
      Copy-Item -LiteralPath $source -Destination $temporary -Force
      $temporaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant()
      if ($temporaryHash -ne ([string]$entry.sha256).ToLowerInvariant()) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        throw "Copy verification failed: $relative"
      }
      $applied += $changes | Where-Object path -eq $relative | Select-Object -First 1
      [IO.File]::Copy($temporary, $target, $true)
      Remove-Item -LiteralPath $temporary -Force
    }

    foreach ($entry in $manifest.files) {
      $target = Safe-ChildPath $InstallRoot ([string]$entry.path)
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
      if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Installed hash check failed: $($entry.path)" }
    }
  }
  catch {
    Write-Warning "Update failed. Restoring the files changed during this attempt."
    $rollback = @($applied)
    [array]::Reverse($rollback)
    foreach ($change in $rollback) {
      $target = Safe-ChildPath $InstallRoot $change.path
      if ($change.existed) {
        $backup = Safe-ChildPath $backupRoot $change.path
        if (Test-Path -LiteralPath $backup -PathType Leaf) { Copy-Item -LiteralPath $backup -Destination $target -Force }
      }
      else {
        Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
      }
    }
    throw
  }

  $report = [ordered]@{
    updateId = [string]$manifest.updateId
    installedUtc = (Get-Date).ToUniversalTime().ToString("o")
    backup = $backupRoot
    files = $manifest.files.Count
  }
  $reportPath = Safe-ChildPath $InstallRoot ("test-updates/" + [string]$manifest.updateId + ".json")
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportPath) | Out-Null
  $report | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding UTF8

  Write-Host ""
  Write-Host "Update installed and hash-verified." -ForegroundColor Green
  Write-Host "Backup: $backupRoot"
  Write-Host "Open RevivalSide yourself when ready to test."
  exit 0
}
catch {
  Write-Host ""
  Write-Host "Update was not installed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
'@
  $installerPath = Join-Path $stageRoot "Install-RevivalSide-PvP-Test.ps1"
  Set-Content -LiteralPath $installerPath -Value $installerTemplate -Encoding UTF8

  $cmd = @'
@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-RevivalSide-PvP-Test.ps1"
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (
  echo RevivalSide PvP test update is ready.
) else (
  echo Nothing else was started. Review the message above.
)
pause
exit /b %RESULT%
'@
  Set-Content -LiteralPath (Join-Path $stageRoot "Setup RevivalSide PvP Test.cmd") -Value $cmd -Encoding ASCII

  $readme = @"
RevivalSide Private PvP Relay Test Update
Update ID: $updateId

REQUIREMENTS
- An existing RevivalSide v0.4.0 installation on Windows x64 or Windows 11 ARM64.
- On Windows 11 ARM64, standard x64 app compatibility must be enabled.
- Close RevivalSide, CounterSide, the listener, and CombatHost first.
- Extract this entire ZIP before running it.

INSTALL
1. Double-click "Setup RevivalSide PvP Test.cmd".
2. The updater verifies every payload file before changing the installation.
3. Existing replaced files are backed up under:
   %LOCALAPPDATA%\RevivalSide\.backups
4. The updater does not touch launcher-settings.json, server-data, frozen-client,
   captures, mods, logs, accounts, or saves. It does not launch the game.

TESTING
- Open RevivalSide normally after the updater succeeds.
- Starting the game through the launcher reapplies the Friendly Battle UI patch.
- The relay owner enters the VPS/SSH/TLS fields in PvP Relay Server and selects
  Deploy Relay. Testers only need the HTTPS relay URL, shared relay secret, and
  the host ID supplied by the relay owner.
- Use Host Relay on the host PC and Join Relay on the guest PC. The two players
  then create/join the Friendly Battle room in CounterSide.
- EASY TAILSCALE LEGACY P2P: both testers install Tailscale and sign into the
  same tailnet. The host opens PvP settings and clicks "Host & copy code", then
  sends the copied code to the guest. The guest pastes it and clicks "Join host".
  The launcher selects and fills Legacy P2P automatically. If Tailscale is not
  installed or signed in, "Install / connect Tailscale" opens the official next
  step; click the role button again after sign-in finishes.
- For a trusted local LAN without Tailscale, the manual Legacy P2P Host and Join
  fields remain available. Never port-forward legacy ports 22000 or 8088 to the
  public internet.

SECURITY
- This package contains no relay secret, SSH key, TLS key, account, save, or
  launcher settings. Share credentials separately through a trusted channel.
- No Tailscale auth key is bundled or requested. Each tester signs into their
  own Tailscale client, and the easy guest path accepts only Tailscale 100.x
  addresses or full .ts.net MagicDNS names.
- The PowerShell updater is included as readable source. Windows may warn because
  this private test package is not code-signed.
"@
  Set-Content -LiteralPath (Join-Path $stageRoot "README.txt") -Value $readme -Encoding UTF8

  $finalFolder = Join-Path $OutputDir ("RevivalSide-PvP-Relay-Test-" + $buildStamp + "-" + $fingerprint)
  if (Test-Path -LiteralPath $finalFolder) { throw "Output already exists: $finalFolder" }
  Remove-ExactTree $buildRoot $stageRoot
  Move-Item -LiteralPath $stageRoot -Destination $finalFolder
  $stageRoot = ""

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipPath = "$finalFolder.zip"
  if (Test-Path -LiteralPath $zipPath) { throw "Output already exists: $zipPath" }
  [IO.Compression.ZipFile]::CreateFromDirectory($finalFolder, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)

  Write-Host "Smoke-testing the updater against an isolated fake v0.4.0 install"
  $testRoot = Join-Path ([IO.Path]::GetTempPath()) ("RevivalSide-PvpUpdateTest-" + [Guid]::NewGuid().ToString("N"))
  $extractRoot = Join-Path $testRoot "package"
  $fakeInstall = Join-Path $testRoot "install"
  New-Item -ItemType Directory -Force -Path $extractRoot, (Join-Path $fakeInstall "server"), (Join-Path $fakeInstall "tools") | Out-Null
  try {
    [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractRoot)
    '{"name":"revivalside","version":"0.4.0"}' | Set-Content -LiteralPath (Join-Path $fakeInstall "package.json") -Encoding ASCII
    "old-launcher" | Set-Content -LiteralPath (Join-Path $fakeInstall "RevivalSideLauncher.exe") -Encoding ASCII
    "old-listener" | Set-Content -LiteralPath (Join-Path $fakeInstall "server\listener.js") -Encoding ASCII
    New-Item -ItemType Directory -Force -Path (Join-Path $fakeInstall "tools") | Out-Null
    "old-backend" | Set-Content -LiteralPath (Join-Path $fakeInstall "tools\revivalside-launcher-backend.js") -Encoding ASCII
    "settings-sentinel" | Set-Content -LiteralPath (Join-Path $fakeInstall "launcher-settings.json") -Encoding ASCII
    New-Item -ItemType Directory -Force -Path (Join-Path $fakeInstall "server-data") | Out-Null
    "save-sentinel" | Set-Content -LiteralPath (Join-Path $fakeInstall "server-data\users.sqlite") -Encoding ASCII

    Invoke-Checked "powershell.exe" @(
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      (Join-Path $extractRoot "Install-RevivalSide-PvP-Test.ps1"),
      "-InstallRoot", $fakeInstall, "-NonInteractive"
    ) "Isolated updater smoke test"

    $testManifest = Get-Content -LiteralPath (Join-Path $extractRoot "manifest.json") -Raw | ConvertFrom-Json
    foreach ($entry in $testManifest.files) {
      $installed = Join-Path $fakeInstall ([string]$entry.path).Replace('/', '\')
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installed).Hash.ToLowerInvariant()
      if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Smoke-test hash mismatch: $($entry.path)" }
    }
    if ((Get-Content -LiteralPath (Join-Path $fakeInstall "launcher-settings.json") -Raw).Trim() -ne "settings-sentinel") {
      throw "The updater changed launcher-settings.json during the smoke test."
    }
    if ((Get-Content -LiteralPath (Join-Path $fakeInstall "server-data\users.sqlite") -Raw).Trim() -ne "save-sentinel") {
      throw "The updater changed server-data during the smoke test."
    }
    $backup = Get-ChildItem -LiteralPath (Join-Path $fakeInstall ".backups") -Directory | Select-Object -First 1
    if (-not $backup -or -not (Test-Path -LiteralPath (Join-Path $backup.FullName "RevivalSideLauncher.exe") -PathType Leaf)) {
      throw "The smoke test did not create the expected launcher backup."
    }
  }
  finally {
    Remove-ExactTree $testRoot ([IO.Path]::GetTempPath())
  }

  $zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  Write-Host ""
  Write-Host "PvP test update ready" -ForegroundColor Green
  Write-Host "Folder: $finalFolder"
  Write-Host "ZIP: $zipPath"
  Write-Host "SHA256: $zipHash"
}
catch {
  if ($stageRoot) { Remove-ExactTree $stageRoot $OutputDir }
  if ($finalFolder -and (Test-Path -LiteralPath $finalFolder -PathType Container)) {
    Remove-ExactTree $finalFolder $OutputDir
  }
  if ($zipPath -and (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
    $fullZip = [IO.Path]::GetFullPath($zipPath)
    $fullOutput = [IO.Path]::GetFullPath($OutputDir).TrimEnd('\') + '\'
    if (-not $fullZip.StartsWith($fullOutput, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a ZIP outside the output directory: $fullZip"
    }
    Remove-Item -LiteralPath $fullZip -Force
  }
  throw
}
