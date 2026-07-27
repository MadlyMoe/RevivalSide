param(
  [ValidateSet("win-x64", "win-x86", "win-arm64")]
  [string]$RuntimeIdentifier = "win-x64",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$rootPath = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $rootPath "launcher"

$rustTarget = switch ($RuntimeIdentifier) {
  "win-x64" { "x86_64-pc-windows-msvc" }
  "win-x86" { "i686-pc-windows-msvc" }
  "win-arm64" { "aarch64-pc-windows-msvc" }
}

$targetArchitecture = switch ($RuntimeIdentifier) {
  "win-x64" { "x64" }
  "win-x86" { "x86" }
  "win-arm64" { "arm64" }
}

function Find-VsDevCmd {
  $vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

  foreach ($vswhere in $vswhereCandidates) {
    $installations = & $vswhere -products * -property installationPath
    foreach ($installation in $installations) {
      $candidate = Join-Path $installation "Common7\Tools\VsDevCmd.bat"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  return ""
}

function Initialize-MsvcEnvironment([string]$TargetArchitecture) {
  if (Get-Command cl.exe -ErrorAction SilentlyContinue) { return }
  $vsDevCmd = Find-VsDevCmd
  if (-not $vsDevCmd) {
    throw "Visual Studio C++ build tools were not found. Install the Desktop development with C++ workload before building the launcher."
  }

  $hostArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
  if ($hostArchitecture -notin @("x64", "x86", "arm64")) { $hostArchitecture = "x64" }
  $commandLine = 'call "' + $vsDevCmd + '" -no_logo -arch=' + $TargetArchitecture + ' -host_arch=' + $hostArchitecture + ' && set'
  $environmentLines = & cmd.exe /d /c $commandLine
  if ($LASTEXITCODE -ne 0) { throw "Visual Studio developer environment initialization failed for $TargetArchitecture." }

  foreach ($line in $environmentLines) {
    if ($line -match '^([^=]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
    }
  }
  if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "Visual Studio developer environment did not expose cl.exe for $TargetArchitecture."
  }
}

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath (Join-Path $cargoBin "cargo.exe") -PathType Leaf)) {
  $env:Path = "$cargoBin;$env:Path"
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "npm.cmd was not found. Install Node.js before building the launcher."
}
if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
  throw "cargo.exe was not found. Install the Rust MSVC toolchain before building the Tauri launcher."
}

Initialize-MsvcEnvironment $targetArchitecture

Push-Location $launcherPath
try {
  if (-not (Test-Path -LiteralPath (Join-Path $launcherPath "node_modules") -PathType Container)) {
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "Launcher npm install failed" }
  }

  $rustHostLine = (& rustc.exe -vV | Where-Object { $_ -like "host:*" } | Select-Object -First 1)
  $rustHost = if ($rustHostLine) { $rustHostLine.Substring(5).Trim() } else { "" }
  $tauriArgs = @("tauri", "build", "--no-bundle")
  if ($rustHost -ne $rustTarget) { $tauriArgs += @("--target", $rustTarget) }
  npx.cmd @tauriArgs
  if ($LASTEXITCODE -ne 0) { throw "Launcher Tauri build failed for $RuntimeIdentifier" }
}
finally {
  Pop-Location
}

$releaseSubdir = if ($rustHost -eq $rustTarget) { "src-tauri\target\release" } else { "src-tauri\target\$rustTarget\release" }
$builtLauncher = Join-Path $launcherPath "$releaseSubdir\RevivalSideLauncher.exe"
if (-not (Test-Path -LiteralPath $builtLauncher -PathType Leaf)) {
  throw "Built launcher was not found: $builtLauncher"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  Write-Output $builtLauncher
  exit 0
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Copy-Item -LiteralPath $builtLauncher -Destination (Join-Path $OutputDir "RevivalSideLauncher.exe") -Force
Write-Host "Launcher copied to $OutputDir"
