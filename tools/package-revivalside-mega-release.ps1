param(
  [string]$OutputDir = "",
  [ValidateSet("win-x64", "win-x86", "win-arm64")]
  [string]$RuntimeIdentifier = "",
  [string]$NodePath = "",
  [string]$PythonPath = "",
  [switch]$SkipGameplayJsons,
  [switch]$IncludeGameplayJsons,
  [switch]$IncludeWikiAssets,
  [switch]$SkipWikiAssets,
  [switch]$Zip
)

$ErrorActionPreference = "Stop"

function Get-HostWindowsRid {
  $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($dotnetCommand) {
    $ridLine = (& dotnet --info 2>$null | Select-String -Pattern "^\s*RID:\s*(\S+)" | Select-Object -First 1)
    if ($ridLine -and $ridLine.Matches.Count -gt 0) {
      $rid = $ridLine.Matches[0].Groups[1].Value
      if ($rid -in @("win-x64", "win-x86", "win-arm64")) { return $rid }
    }
  }
  $processorText = "$env:PROCESSOR_ARCHITECTURE $env:PROCESSOR_ARCHITEW6432 $env:PROCESSOR_IDENTIFIER"
  if ($processorText -match "ARM64|ARMv8|AARCH64") { return "win-arm64" }
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" { return "win-x64" }
    "x86" { return "win-x86" }
    "arm64" { return "win-arm64" }
    default { throw "Unsupported Windows host architecture: $arch" }
  }
}

function Get-RidArchitecture([string]$Rid) {
  switch ($Rid) {
    "win-x64" { return "x64" }
    "win-x86" { return "x86" }
    "win-arm64" { return "arm64" }
    default { throw "Unsupported runtime identifier: $Rid" }
  }
}

function Get-CombatHostRid([string]$Rid) {
  if ($Rid -eq "win-arm64") { return "win-x64" }
  return $Rid
}

function Get-PeMachine([string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath)) { return "" }
  $bytes = [System.IO.File]::ReadAllBytes($FilePath)
  if ($bytes.Length -lt 64) { return "" }
  if ([System.BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) { return "" }
  $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
  if ($peOffset -lt 0 -or ($peOffset + 6) -gt $bytes.Length) { return "" }
  $machine = [System.BitConverter]::ToUInt16($bytes, $peOffset + 4)
  switch ($machine) {
    0x014c { return "x86" }
    0x8664 { return "x64" }
    0xaa64 { return "arm64" }
    0x01c4 { return "arm" }
    default { return ("0x{0:x}" -f $machine) }
  }
}

function Assert-ExecutableArchitecture([string]$FilePath, [string]$ExpectedArchitecture, [string]$Name) {
  if (-not (Test-Path -LiteralPath $FilePath)) {
    throw "$Name was not found: $FilePath"
  }
  $actual = Get-PeMachine $FilePath
  if (-not $actual) {
    throw "$Name is not a Windows PE executable: $FilePath"
  }
  if ($actual -ne $ExpectedArchitecture) {
    throw "$Name architecture mismatch for ${RuntimeIdentifier}: expected $ExpectedArchitecture, found $actual at $FilePath"
  }
}

function Copy-DirectoryClean([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required directory was not found: $Source"
  }
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Resolve-PythonRuntimeRoot([string]$PythonExe) {
  if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    throw "Python executable was not found: $PythonExe"
  }
  $pythonDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($PythonExe))
  $pythonParent = Split-Path -Parent $pythonDir
  if ((Split-Path -Leaf $pythonDir).Equals("Scripts", [System.StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath (Join-Path $pythonParent "pyvenv.cfg") -PathType Leaf)) {
    return $pythonParent
  }
  return $pythonDir
}

function Get-PackagedPythonExe([string]$RuntimeRoot) {
  foreach ($candidate in @(
    (Join-Path $RuntimeRoot "python.exe"),
    (Join-Path $RuntimeRoot "python3.exe"),
    (Join-Path $RuntimeRoot "Scripts\python.exe")
  )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return ""
}

function Assert-PythonUnityPy([string]$PythonExe, [string]$Name) {
  & $PythonExe -c "import UnityPy; import PIL"
  if ($LASTEXITCODE -ne 0) {
    throw "$Name must be able to import UnityPy and Pillow: $PythonExe"
  }
}

function Copy-PythonRuntime([string]$PythonExe, [string]$Destination) {
  Assert-PythonUnityPy $PythonExe "Python runtime"
  $sourceRoot = Resolve-PythonRuntimeRoot $PythonExe
  Copy-DirectoryClean $sourceRoot $Destination
  $packagedPython = Get-PackagedPythonExe $Destination
  if (-not $packagedPython) {
    throw "Packaged Python runtime did not contain python.exe under $Destination"
  }
  Assert-PythonUnityPy $packagedPython "Packaged Python runtime"
  Write-Host "Bundled Python runtime with UnityPy: $Destination"
}

function Copy-FileRequired([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required file was not found: $Source"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-FileIfPresent([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Source) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
  }
}

function Remove-PdbFiles([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
  Get-ChildItem -LiteralPath $Directory -File -Filter "*.pdb" -ErrorAction SilentlyContinue |
    Remove-Item -Force
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

function Copy-CombatHostOriginalLayout([string]$Destination) {
  $sourceDir = Join-Path $rootPath "combat-host"
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $sourceDir -File |
    Where-Object { $_.Name.EndsWith(".cs", [System.StringComparison]::OrdinalIgnoreCase) -or $_.Name.EndsWith(".csproj", [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name) -Force }

  $stamp = Get-CombatHostSourceStamp $sourceDir
  $cacheOut = Join-Path $Destination "bin\host-cache\$stamp"
  if (Test-Path -LiteralPath $cacheOut) {
    Remove-Item -LiteralPath $cacheOut -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $cacheOut | Out-Null
  dotnet publish (Join-Path $sourceDir "CombatHost.csproj") `
    -c Release `
    --self-contained false `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    --nologo `
    -o $cacheOut
  if ($LASTEXITCODE -ne 0) { throw "CombatHost project-cache publish failed" }
  foreach ($required in @("CombatHost.dll", "CombatHost.deps.json", "CombatHost.runtimeconfig.json")) {
    $requiredPath = Join-Path $cacheOut $required
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "CombatHost project-cache output is missing $requiredPath"
    }
  }
  Write-Host "CombatHost original project layout: source + host-cache\$stamp"
}

function Write-CleanUsersJson([string]$Path, [string]$StarterUsersPath) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  if (Test-Path -LiteralPath $StarterUsersPath -PathType Leaf) {
    $starter = Get-Content -LiteralPath $StarterUsersPath -Raw | ConvertFrom-Json
    if (-not $starter.users -or -not $starter.activeUserUid -or -not $starter.users.PSObject.Properties[$starter.activeUserUid]) {
      throw "Starter users.json is missing an active starter profile: $StarterUsersPath"
    }
    Copy-FileRequired $StarterUsersPath $Path
    return
  }
  throw "Starter users.json was not found: $StarterUsersPath"
}

function Copy-CapturedFlowMirrorFixtures([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $manifestPath = Join-Path $Source "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Warning "No captured HTTP bootstrap mirror manifest found at $manifestPath"
    return
  }

  Copy-FileRequired $manifestPath (Join-Path $Destination "manifest.json")
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  foreach ($entry in $manifest) {
    if (-not $entry.bodyFile) { continue }
    $bodyName = [string]$entry.bodyFile
    if ($bodyName.Contains("/") -or $bodyName.Contains("\") -or $bodyName.Contains("..")) {
      throw "Unsafe captured-flow body file in manifest: $bodyName"
    }
    Copy-FileRequired (Join-Path $Source $bodyName) (Join-Path $Destination $bodyName)
  }
}

function Copy-CapturedTcpBootFixtures([string]$Source, [string]$Destination, [string]$RootPath) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $manifestPath = Join-Path $Source "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Warning "No captured TCP manifest found at $manifestPath"
    return
  }

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $filteredManifest = [ordered]@{}
  foreach ($packetId in @("217")) {
    $property = $manifest.PSObject.Properties[$packetId]
    if (-not $property) {
      Write-Warning "Captured TCP manifest does not contain packet $packetId"
      continue
    }

    $entry = $property.Value
    $filteredManifest[$packetId] = $entry
    foreach ($fieldName in @("payloadFile", "rawFile")) {
      $fileName = [string]$entry.$fieldName
      if ([string]::IsNullOrWhiteSpace($fileName)) { continue }
      if ($fileName.Contains("/") -or $fileName.Contains("\") -or $fileName.Contains("..")) {
        throw "Unsafe captured TCP $fieldName in manifest: $fileName"
      }
      Copy-FileRequired (Join-Path $Source $fileName) (Join-Path $Destination $fileName)
    }
  }

  if ($filteredManifest.Count -gt 0) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText(
      (Join-Path $Destination "manifest.json"),
      (($filteredManifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine),
      $utf8NoBom
    )
  }

  if ($manifest.PSObject.Properties["203"]) {
    $templateTool = Join-Path $RootPath "tools\export-captured-login-template.js"
    if (-not (Test-Path -LiteralPath $templateTool -PathType Leaf)) {
      throw "Login template exporter was not found: $templateTool"
    }
    & node $templateTool --source $Source --output (Join-Path $Destination "official-login-template.json")
    if ($LASTEXITCODE -ne 0) {
      throw "Captured login template export failed"
    }
  }
}

function Copy-CapturedGameFlowFixtures([string]$Source, [string]$Destination) {
  $manifestPath = Join-Path $Source "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Write-Warning "No captured game-flow manifest found at $manifestPath"
    return
  }
  Copy-DirectoryClean $Source $Destination
}

function Write-InstallScripts([string]$PackageRoot) {
  $installPs1 = @'
$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $env:LOCALAPPDATA "RevivalSide"
if ((Resolve-Path $source).Path -ieq ([System.IO.Path]::GetFullPath($target))) {
  Write-Host "RevivalSide is already installed at $target"
} else {
  if (Test-Path -LiteralPath $target) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Rename-Item -LiteralPath $target -NewName "RevivalSide.backup.$stamp" -Force
  }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Get-ChildItem -LiteralPath $source -Force | Where-Object {
    $_.Name -notin @("Install RevivalSide.ps1", "Install RevivalSide.bat")
  } | Copy-Item -Destination $target -Recurse -Force
}
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "RevivalSide Launcher.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $target "RevivalSideLauncher.exe"
$shortcut.WorkingDirectory = $target
$shortcut.IconLocation = Join-Path $target "RevivalSideLauncher.exe"
$shortcut.Save()
Start-Process -FilePath (Join-Path $target "RevivalSideLauncher.exe")
Write-Host "Installed RevivalSide to $target"
'@
  $installBat = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install RevivalSide.ps1"
pause
'@
  Set-Content -LiteralPath (Join-Path $PackageRoot "Install RevivalSide.ps1") -Value $installPs1 -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $PackageRoot "Install RevivalSide.bat") -Value $installBat -Encoding ASCII
}

if (-not $RuntimeIdentifier) {
  $RuntimeIdentifier = Get-HostWindowsRid
}
$targetArch = Get-RidArchitecture $RuntimeIdentifier

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$rootPath = $root.Path
if ($SkipGameplayJsons) { Write-Host "SkipGameplayJsons is set; legacy gameplay-jsons will not be copied." }
if (-not $OutputDir) {
  $OutputDir = Join-Path $rootPath "prebuilt\revivalside-mega-release-$RuntimeIdentifier"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$prebuiltRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath "prebuilt"))
$prebuiltRootWithSlash = $prebuiltRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($outputPath -ne $prebuiltRoot -and -not $outputPath.StartsWith($prebuiltRootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDir must stay under $prebuiltRoot; resolved OutputDir=$outputPath"
}

if (-not $NodePath) {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $NodePath = $nodeCommand.Source
}
Assert-ExecutableArchitecture $NodePath $targetArch "node.exe"

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

$wikiAssetsJson = Join-Path $rootPath "wiki\data\assets.json"
$missingWikiData = @("assets.json", "units.json", "gears.json", "gearStats.json", "gearSetBonuses.json", "items.json", "skins.json", "contracts.json", "idIndex.json") |
  Where-Object { -not (Test-Path -LiteralPath (Join-Path $rootPath "wiki\data\$_") -PathType Leaf) }
if ($missingWikiData.Count -gt 0) {
  & node (Join-Path $rootPath "tools\build-revivalside-wiki.js")
  if ($LASTEXITCODE -ne 0) {
    throw "Wiki build failed"
  }
} else {
  Write-Host "Using existing wiki metadata; runtime wiki images will build from installed CounterSide encrypted assets."
}

& powershell -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $rootPath "tools\build-revivalside-launcher.ps1") `
  -RuntimeIdentifier $RuntimeIdentifier `
  -OutputDir $outputPath
if ($LASTEXITCODE -ne 0) { throw "Launcher build failed for $RuntimeIdentifier" }

Remove-PdbFiles $outputPath
$launcherExe = Join-Path $outputPath "RevivalSideLauncher.exe"
Assert-ExecutableArchitecture $launcherExe $targetArch "RevivalSideLauncher.exe"

$combatHostOut = Join-Path $outputPath "combat-host"
$combatHostRid = Get-CombatHostRid $RuntimeIdentifier
$combatHostArch = Get-RidArchitecture $combatHostRid
dotnet publish (Join-Path $rootPath "combat-host\CombatHost.csproj") `
  -c Release `
  -r $combatHostRid `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None `
  -p:DebugSymbols=false `
  --nologo `
  -o $combatHostOut

$combatHostExe = Join-Path $combatHostOut "CombatHost.exe"
Assert-ExecutableArchitecture $combatHostExe $combatHostArch "CombatHost.exe"
Copy-CombatHostOriginalLayout $combatHostOut

$clientPatcherOut = Join-Path $outputPath "tools\CounterPassClientPatcher"
dotnet publish (Join-Path $rootPath "tools\CounterPassClientPatcher\CounterPassClientPatcher.csproj") `
  -c Release `
  -r $RuntimeIdentifier `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None `
  -p:DebugSymbols=false `
  --nologo `
  -o $clientPatcherOut
if ($LASTEXITCODE -ne 0) { throw "CounterSide client patcher publish failed" }
Remove-PdbFiles $clientPatcherOut
Assert-ExecutableArchitecture (Join-Path $clientPatcherOut "CounterPassClientPatcher.exe") $targetArch "CounterPassClientPatcher.exe"

foreach ($fileName in @("cs-listener.js", "package.json", "package-lock.json", ".env.example", "README.md", "CONTRIBUTING.md", "packet-schema.json")) {
  Copy-FileIfPresent (Join-Path $rootPath $fileName) (Join-Path $outputPath $fileName)
}

foreach ($dirName in @("server", "modules", "packet-handlers", "combat-handler", "stages", "wiki")) {
  Copy-DirectoryClean (Join-Path $rootPath $dirName) (Join-Path $outputPath $dirName)
}

$toolsOut = Join-Path $outputPath "tools"
New-Item -ItemType Directory -Force -Path $toolsOut | Out-Null
foreach ($toolName in @(
  "revivalside-launcher-backend.js",
  "build-revivalside-launcher.ps1",
  "remove-legacy-hosts-patch.ps1",
  "check-frozen-client-update.js",
  "check-user-manager-lightweight.js",
  "serve-revivalside-wiki.js",
  "build-revivalside-wiki.js",
  "copy-wiki-assets.js",
  "ensure-gameplay-assets.js",
  "ensure-wiki-assets.js",
  "ensure-cutscene-backgrounds.js",
  "cs_asset_decrypt.py",
  "cs_extract_decrypted_assets.py",
  "event-manager-diagnostics.js",
  "extract-cs-pcap-fixtures.js",
  "import-official-join-lobby-profile.js",
  "import-official-event-schedules.js"
)) {
  Copy-FileIfPresent (Join-Path $rootPath "tools\$toolName") (Join-Path $toolsOut $toolName)
}

$sourceGameplayJsons = Join-Path $rootPath "gameplay-jsons"
if ($IncludeGameplayJsons -and -not $SkipGameplayJsons -and (Test-Path -LiteralPath $sourceGameplayJsons -PathType Container)) {
  Copy-DirectoryClean $sourceGameplayJsons (Join-Path $outputPath "gameplay-jsons")
  Write-Host "Copied optional legacy gameplay-jsons."
} else {
  Write-Host "No packaged gameplay-jsons required; runtime tables load from installed CounterSide luac assets."
}

$serverDataOut = Join-Path $outputPath "server-data"
New-Item -ItemType Directory -Force -Path $serverDataOut | Out-Null
foreach ($dirName in @("captured-flows", "captured-tcp", "captured-game-flow", "users.backups", "official-notices-cache")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $serverDataOut $dirName) | Out-Null
}
Copy-CapturedFlowMirrorFixtures (Join-Path $rootPath "server-data\captured-flows") (Join-Path $serverDataOut "captured-flows")
Copy-CapturedTcpBootFixtures (Join-Path $rootPath "server-data\captured-tcp") (Join-Path $serverDataOut "captured-tcp") $rootPath
Copy-CapturedGameFlowFixtures (Join-Path $rootPath "server-data\captured-game-flow") (Join-Path $serverDataOut "captured-game-flow")
foreach ($fileName in @("README.md", "strings.json", "units.json", "dungeons.json", "items.json", "table_catalog.json", "warfare.json", "starter-users.json")) {
  Copy-FileIfPresent (Join-Path $rootPath "server-data\$fileName") (Join-Path $serverDataOut $fileName)
}
Write-CleanUsersJson (Join-Path $serverDataOut "users.json") (Join-Path $rootPath "server-data\starter-users.json")
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $serverDataOut "server-time.json"), "{}$([Environment]::NewLine)", $utf8NoBom)

$nodeOut = Join-Path $outputPath "runtime\node"
Copy-DirectoryClean (Split-Path -Parent $NodePath) $nodeOut
Assert-ExecutableArchitecture (Join-Path $nodeOut "node.exe") $targetArch "bundled node.exe"
if (-not (Test-Path -LiteralPath (Join-Path $nodeOut "npm.cmd"))) {
  throw "Node runtime folder does not contain npm.cmd: $nodeOut"
}

if ($PythonPath) {
  Copy-PythonRuntime ([System.IO.Path]::GetFullPath($PythonPath)) (Join-Path $outputPath "runtime\python")
} else {
  Write-Host "No bundled Python runtime requested; gameplay asset extraction will use Python from the user's PATH."
}

$runtimeCachePath = Join-Path $outputPath ".cache"
if (Test-Path -LiteralPath $runtimeCachePath) {
  Remove-Item -LiteralPath $runtimeCachePath -Recurse -Force
}

foreach ($runtimeCache in @("obj", "patched-managed")) {
  $cachePath = Join-Path $combatHostOut $runtimeCache
  if (Test-Path -LiteralPath $cachePath) {
    Remove-Item -LiteralPath $cachePath -Recurse -Force
  }
}
Get-ChildItem -LiteralPath $outputPath -Recurse -Force -Filter "Assembly-CSharp.dll" -ErrorAction SilentlyContinue |
  Remove-Item -Force

if ($IncludeWikiAssets -and -not $SkipWikiAssets) {
  & node (Join-Path $rootPath "tools\copy-wiki-assets.js") `
    --assets-json (Join-Path $rootPath "wiki\data\assets.json") `
    --source (Join-Path $rootPath "extracted-assets\all") `
    --output (Join-Path $outputPath "extracted-assets\all")
  if ($LASTEXITCODE -ne 0) {
    throw "Wiki asset packaging failed"
  }
} else {
  Write-Host "No full extracted wiki asset dump packaged."
}

Write-Host "No cutscene background asset pack packaged; launcher backgrounds are derived from installed CounterSide assets."

Write-InstallScripts $outputPath

@"
RevivalSide Mega Release ($RuntimeIdentifier)

Run RevivalSideLauncher.exe directly, or run Install RevivalSide.bat to copy this
bundle to %LOCALAPPDATA%\RevivalSide and create a desktop shortcut.

Included:
- Local listener start/stop launcher.
- User Manager at http://127.0.0.1:8088/user-manager while the listener is running.
- Local wiki launcher.
- Optional wiki/cutscene image assets when present in the package.
- Direct frozen-client URL routing with no Windows hosts-file changes.
- Steam-isolated frozen launch with zero managed Steamworks callsites and native Steam API DLLs quarantined.
- Frozen-build update metadata served from the archived client's own Version.json and PatchInfo.json.
- Automatic CounterSide client patch and isolation audit before listener start.
- Server time controls.
- Listener settings, ports, feature toggles, and advanced env overrides.
- CounterSide Assembly-CSharp.dll path selector with Steam auto-detect.
- Gameplay tables derived from installed encrypted CounterSide script assets; no gameplay-jsons or decompiled table dump is required.
- Launcher cutscene backgrounds derived from installed encrypted CounterSide image assets; no cutscene asset pack is bundled.
- Starter server-data/users.json profile based on the captured Admin_3114263075 account. Personal account databases are not bundled.
- Small HTTP bootstrap fixtures for ServerInfo/PatchInfo mirroring.
- Captured boot/content ACK fixture and sanitized login tag template for official login-screen parity.
- Captured game-flow boot templates used by the listener's replay helpers.

Requirements:
- CounterSide must be installed locally. Select Data\Managed\Assembly-CSharp.dll if auto-detect fails.
- If this package does not include runtime\python, Python with UnityPy and Pillow must be available to build first-run gameplay and cutscene caches.

Ports:
- Game listener: 22000
- User Manager / launcher API: 8088
- Wiki: 5174
"@ | Set-Content -LiteralPath (Join-Path $outputPath "README.txt") -Encoding UTF8

if ($Zip) {
  $zipPath = "$outputPath.zip"
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -Path (Join-Path $outputPath "*") -DestinationPath $zipPath -Force
  Write-Host "Packaged $zipPath"
} else {
  Write-Host "Packaged $outputPath"
}
