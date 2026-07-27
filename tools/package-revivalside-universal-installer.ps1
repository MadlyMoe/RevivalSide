param(
  [string]$OutputDir = "",
  [string]$RuntimeCacheDir = "",
  [string]$NodeVersion = "v22.22.3",
  [string]$PythonVersion = "3.13.5",
  [string]$WiresharkVersion = "4.6.6",
  [string]$WiresharkWin32Version = "3.6.24",
  [string]$NpcapVersion = "1.88",
  [string]$DotNetChannel = "8.0",
  [string]$PythonPath = "",
  [string[]]$PythonRequirements = @("UnityPy==1.25.0", "Pillow==12.2.0"),
  [ValidateSet("win-x64", "win-x86", "win-arm64")]
  [string[]]$RuntimeIdentifiers = @("win-arm64", "win-x64", "win-x86"),
  [switch]$SkipWikiAssets
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$rootPath = $root.Path
if (-not $OutputDir) {
  $OutputDir = Join-Path $rootPath "prebuilt\revivalside-universal-installer"
}
if (-not $RuntimeCacheDir) {
  $RuntimeCacheDir = Join-Path $rootPath "prebuilt\revivalside-mega-runtimes"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$prebuiltRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath "prebuilt"))
$prebuiltRootWithSlash = $prebuiltRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($outputPath -ne $prebuiltRoot -and -not $outputPath.StartsWith($prebuiltRootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDir must stay under $prebuiltRoot; resolved OutputDir=$outputPath"
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
  if ($actual -ne $ExpectedArchitecture) {
    throw "$Name architecture mismatch: expected $ExpectedArchitecture, found $actual at $FilePath"
  }
}

function Test-ExecutableArchitecture([string]$FilePath, [string]$ExpectedArchitecture) {
  return (Test-Path -LiteralPath $FilePath) -and ((Get-PeMachine $FilePath) -eq $ExpectedArchitecture)
}

function Copy-DirectoryClean([string]$Source, [string]$Destination) {
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

function Save-Url([string]$Url, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) { return }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Resolve-SevenZipExtractor {
  $toolRoot = Join-Path $RuntimeCacheDir "extract-tools\7zip"
  $sevenZip = Join-Path $toolRoot "x64\7z.exe"
  if ((Test-Path -LiteralPath $sevenZip -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $sevenZip) "7z.dll") -PathType Leaf)) {
    return $sevenZip
  }

  $bootstrap = Join-Path $toolRoot "7zr.exe"
  $installer = Join-Path $toolRoot "7z2601-x64.exe"
  Save-Url "https://github.com/ip7z/7zip/releases/download/26.01/7zr.exe" $bootstrap
  Save-Url "https://github.com/ip7z/7zip/releases/download/26.01/7z2601-x64.exe" $installer

  $extractRoot = Join-Path $toolRoot "x64"
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  & $bootstrap x $installer "-o$extractRoot" -y | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "7-Zip extractor bootstrap failed" }
  if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
    throw "7-Zip extractor did not contain 7z.exe"
  }
  return $sevenZip
}

function Expand-WithSevenZip([string]$Archive, [string]$Destination) {
  $sevenZip = Resolve-SevenZipExtractor
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & $sevenZip x $Archive "-o$Destination" -y | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "7-Zip extraction failed for $Archive" }
}

function Resolve-NodeRuntime([string]$Rid) {
  $expectedArch = Get-RidArchitecture $Rid
  $cachedNode = Join-Path $RuntimeCacheDir "node\$Rid\node.exe"
  $cachedNpm = Join-Path $RuntimeCacheDir "node\$Rid\npm.cmd"
  if ((Test-Path -LiteralPath $cachedNode) -and (Test-Path -LiteralPath $cachedNpm) -and ((Get-PeMachine $cachedNode) -eq $expectedArch)) {
    return $cachedNode
  }

  $nodeArch = switch ($Rid) {
    "win-x64" { "x64" }
    "win-x86" { "x86" }
    "win-arm64" { "arm64" }
  }
  $fileName = "node-$NodeVersion-win-$nodeArch.zip"
  $zipPath = Join-Path $RuntimeCacheDir "downloads\$fileName"
  Save-Url "https://nodejs.org/dist/$NodeVersion/$fileName" $zipPath

  $extractRoot = Join-Path $RuntimeCacheDir "node-expand\$Rid"
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
  $nodeDir = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (-not $nodeDir) { throw "Node archive did not contain a runtime directory: $zipPath" }

  $cachedDir = Split-Path -Parent $cachedNode
  if (Test-Path -LiteralPath $cachedDir) {
    Remove-Item -LiteralPath $cachedDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $cachedDir | Out-Null
  Get-ChildItem -LiteralPath $nodeDir.FullName -Force | Copy-Item -Destination $cachedDir -Recurse -Force
  Assert-ExecutableArchitecture $cachedNode $expectedArch "node.exe"
  if (-not (Test-Path -LiteralPath $cachedNpm)) {
    throw "Node archive did not contain npm.cmd: $zipPath"
  }
  return $cachedNode
}

function Get-PythonEmbedFileName([string]$Rid) {
  switch ($Rid) {
    "win-x64" { return "python-$PythonVersion-embed-amd64.zip" }
    "win-x86" { return "python-$PythonVersion-embed-win32.zip" }
    "win-arm64" { return "python-$PythonVersion-embed-amd64.zip" }
    default { throw "Unsupported runtime identifier: $Rid" }
  }
}

function Get-PythonWheelPlatform([string]$Rid) {
  switch ($Rid) {
    "win-x64" { return "win_amd64" }
    "win-x86" { return "win32" }
    "win-arm64" { return "win_amd64" }
    default { throw "Unsupported runtime identifier: $Rid" }
  }
}

function Get-PythonVersionTag {
  $parts = $PythonVersion.Split(".")
  if ($parts.Length -lt 2) { throw "PythonVersion must look like 3.13.5; got $PythonVersion" }
  return "$($parts[0])$($parts[1])"
}

function Resolve-PythonPackageWheelhouse([string]$Rid) {
  $platform = Get-PythonWheelPlatform $Rid
  $pyTag = Get-PythonVersionTag
  $packageRoot = Join-Path $RuntimeCacheDir "python-packages\$Rid"
  $wheelhouse = Join-Path $packageRoot "wheelhouse"
  $requirementsPath = Join-Path $packageRoot "requirements.txt"
  $stampPath = Join-Path $packageRoot ".complete"
  $requirementsText = ($PythonRequirements -join [Environment]::NewLine) + [Environment]::NewLine
  if ((Test-Path -LiteralPath $stampPath -PathType Leaf) -and
      (Test-Path -LiteralPath $requirementsPath -PathType Leaf) -and
      ((Get-Content -Raw -LiteralPath $requirementsPath) -eq $requirementsText)) {
    return $packageRoot
  }

  if (Test-Path -LiteralPath $packageRoot) {
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $wheelhouse | Out-Null
  Set-Content -LiteralPath $requirementsPath -Value $requirementsText -Encoding UTF8

  $pythonForPip = $PythonPath
  if (-not $pythonForPip) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) { throw "Python is required at package-build time to download the offline UnityPy/Pillow wheelhouse." }
    $pythonForPip = $pythonCommand.Source
  }

  Write-Host "Downloading Python package wheelhouse for $Rid ($platform, cp$pyTag)"
  $pipArgs = @(
    "-m", "pip", "download",
    "--only-binary=:all:",
    "--dest", $wheelhouse,
    "--platform", $platform,
    "--python-version", $pyTag,
    "--implementation", "cp",
    "--abi", "cp$pyTag"
  ) + $PythonRequirements
  $pipOut = Join-Path $packageRoot "pip-download.out.log"
  $pipErr = Join-Path $packageRoot "pip-download.err.log"
  $pipProcess = Start-Process `
    -FilePath $pythonForPip `
    -ArgumentList ($pipArgs | ForEach-Object { Quote-ProcessArgument $_ }) `
    -WorkingDirectory $packageRoot `
    -RedirectStandardOutput $pipOut `
    -RedirectStandardError $pipErr `
    -WindowStyle Hidden `
    -PassThru `
    -Wait
  if (Test-Path -LiteralPath $pipOut) { Get-Content -LiteralPath $pipOut | ForEach-Object { Write-Host $_ } }
  if (Test-Path -LiteralPath $pipErr) { Get-Content -LiteralPath $pipErr | ForEach-Object { Write-Host $_ } }
  if ($pipProcess.ExitCode -ne 0) { throw "Python package wheelhouse download failed for $Rid" }
  Set-Content -LiteralPath $stampPath -Value (Get-Date -Format "o") -Encoding ASCII
  return $packageRoot
}

function Resolve-PythonRuntime([string]$Rid) {
  $cachedDir = Join-Path $RuntimeCacheDir "python-embed\$Rid"
  $cachedPython = Join-Path $cachedDir "python.exe"
  if (Test-Path -LiteralPath $cachedPython -PathType Leaf) {
    try {
      Assert-PythonUnityPy $cachedPython "Cached Python runtime"
      return $cachedDir
    } catch {
      Remove-Item -LiteralPath $cachedDir -Recurse -Force
    }
  }

  $fileName = Get-PythonEmbedFileName $Rid
  $zipPath = Join-Path $RuntimeCacheDir "downloads\$fileName"
  Save-Url "https://www.python.org/ftp/python/$PythonVersion/$fileName" $zipPath

  $extractRoot = Join-Path $RuntimeCacheDir "python-embed-expand\$Rid"
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

  if (Test-Path -LiteralPath $cachedDir) {
    Remove-Item -LiteralPath $cachedDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $cachedDir | Out-Null
  Get-ChildItem -LiteralPath $extractRoot -Force | Copy-Item -Destination $cachedDir -Recurse -Force

  $packageRoot = Resolve-PythonPackageWheelhouse $Rid
  $wheelhouse = Join-Path $packageRoot "wheelhouse"
  $sitePackages = Join-Path $cachedDir "Lib\site-packages"
  New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  foreach ($wheel in Get-ChildItem -LiteralPath $wheelhouse -File -Filter "*.whl") {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($wheel.FullName, $sitePackages)
  }

  $pth = Get-ChildItem -LiteralPath $cachedDir -File -Filter "python*._pth" | Select-Object -First 1
  if ($pth) {
    $lines = Get-Content -LiteralPath $pth.FullName
    $next = @()
    foreach ($line in $lines) {
      if ($line.Trim() -eq "#import site") { continue }
      if ($line.Trim() -eq "import site") { continue }
      if ($line.Trim() -eq "Lib\site-packages") { continue }
      $next += $line
    }
    $next += "Lib\site-packages"
    $next += "import site"
    Set-Content -LiteralPath $pth.FullName -Value $next -Encoding ASCII
  }

  Assert-PythonUnityPy $cachedPython "Packaged Python runtime"
  Write-Host "Bundled Python runtime with UnityPy/Pillow for $Rid`: $cachedDir"
  return $cachedDir
}

function Find-InstalledWiresharkDir([string]$ExpectedArchitecture) {
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Wireshark") }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Wireshark") }
  $tsharkCommand = Get-Command tshark -ErrorAction SilentlyContinue
  if ($tsharkCommand) { $candidates += (Split-Path -Parent $tsharkCommand.Source) }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ((Test-ExecutableArchitecture (Join-Path $candidate "dumpcap.exe") $ExpectedArchitecture) -and
        (Test-ExecutableArchitecture (Join-Path $candidate "tshark.exe") $ExpectedArchitecture)) {
      return $candidate
    }
  }
  return ""
}

function Remove-WiresharkInstallerArtifacts([string]$Directory) {
  foreach ($directoryName in @('$PLUGINSDIR')) {
    $path = Join-Path $Directory $directoryName
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
  foreach ($pattern in @("npcap-*.exe", "USBPcapSetup-*.exe", "vc_redist*.exe", "uninstall.exe")) {
    Get-ChildItem -LiteralPath $Directory -File -Filter $pattern -ErrorAction SilentlyContinue |
      Remove-Item -Force
  }
}

function Resolve-WiresharkRuntime([string]$Rid) {
  $expectedArch = Get-RidArchitecture $Rid
  $cachedDir = Join-Path $RuntimeCacheDir "wireshark\$Rid"
  if ((Test-ExecutableArchitecture (Join-Path $cachedDir "dumpcap.exe") $expectedArch) -and
      (Test-ExecutableArchitecture (Join-Path $cachedDir "tshark.exe") $expectedArch)) {
    Remove-WiresharkInstallerArtifacts $cachedDir
    return $cachedDir
  }

  $installed = Find-InstalledWiresharkDir $expectedArch
  if ($installed) {
    return $installed
  }

  if ($Rid -eq "win-x86") {
    $fileName = "Wireshark-win32-$WiresharkWin32Version.exe"
    $url = "https://www.wireshark.org/download/win32/all-versions/$fileName"
  } else {
    $wiresharkArch = Get-RidArchitecture $Rid
    $fileName = "Wireshark-$WiresharkVersion-$wiresharkArch.exe"
    $url = "https://2.na.dl.wireshark.org/win64/$fileName"
  }

  $installerPath = Join-Path $RuntimeCacheDir "downloads\$fileName"
  Save-Url $url $installerPath

  if (Test-Path -LiteralPath $cachedDir) {
    Remove-Item -LiteralPath $cachedDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cachedDir) | Out-Null

  Write-Host "Extracting Wireshark runtime for $Rid"
  Expand-WithSevenZip $installerPath $cachedDir

  Remove-WiresharkInstallerArtifacts $cachedDir
  Assert-ExecutableArchitecture (Join-Path $cachedDir "dumpcap.exe") $expectedArch "dumpcap.exe"
  Assert-ExecutableArchitecture (Join-Path $cachedDir "tshark.exe") $expectedArch "tshark.exe"
  return $cachedDir
}

function Resolve-DotNetRuntimeInstaller([string]$Rid) {
  $metadataPath = Join-Path $RuntimeCacheDir "downloads\dotnet-$DotNetChannel-releases.json"
  Save-Url "https://builds.dotnet.microsoft.com/dotnet/release-metadata/$DotNetChannel/releases.json" $metadataPath
  $metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
  $latestRuntime = [string]$metadata.'latest-runtime'
  if (-not $latestRuntime) { throw ".NET release metadata did not include latest-runtime for $DotNetChannel" }
  $release = $metadata.releases | Where-Object { $_.runtime.version -eq $latestRuntime } | Select-Object -First 1
  if (-not $release) { throw ".NET release metadata did not include runtime $latestRuntime" }
  $file = $release.runtime.files |
    Where-Object { $_.rid -eq $Rid -and [string]$_.url -match "dotnet-runtime-.*\.exe$" } |
    Select-Object -First 1
  if (-not $file) { throw ".NET runtime installer was not found for $Rid in $DotNetChannel metadata" }
  $fileName = Split-Path -Leaf ([string]$file.url)
  $installerPath = Join-Path $RuntimeCacheDir "downloads\$fileName"
  Save-Url ([string]$file.url) $installerPath
  return $installerPath
}

function Resolve-NpcapInstaller {
  $downloadsDir = Join-Path $RuntimeCacheDir "downloads"
  $desired = Join-Path $downloadsDir "npcap-$NpcapVersion.exe"
  if (Test-Path -LiteralPath $desired -PathType Leaf) {
    return $desired
  }

  $cached = Get-ChildItem -LiteralPath $RuntimeCacheDir -Recurse -File -Filter "npcap-*.exe" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1
  try {
    Save-Url "https://npcap.com/dist/npcap-$NpcapVersion.exe" $desired
    if (Test-Path -LiteralPath $desired -PathType Leaf) {
      return $desired
    }
  }
  catch {
    if ($cached) {
      Write-Host "Npcap $NpcapVersion download failed; using cached $($cached.Name)"
      return $cached.FullName
    }
    throw
  }
  if ($cached) {
    Write-Host "Npcap $NpcapVersion download produced no file; using cached $($cached.Name)"
    return $cached.FullName
  }
  throw "Npcap installer was not found or downloaded: $desired"
}

function Quote-ProcessArgument([string]$Value) {
  if ($null -eq $Value) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Copy-InstallerFile([string]$Source, [string]$DestinationDir) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Installer was not found: $Source"
  }
  New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
  Copy-Item -LiteralPath $Source -Destination (Join-Path $DestinationDir (Split-Path -Leaf $Source)) -Force
}

function Remove-IfPresent([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Remove-PdbFiles([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
  Get-ChildItem -LiteralPath $Directory -File -Filter "*.pdb" -ErrorAction SilentlyContinue |
    Remove-Item -Force
}

if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

$payloadRoot = Join-Path $outputPath "payload"
$appPayload = Join-Path $payloadRoot "app"

Write-Host "Building shared app payload"
$sharedArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $rootPath "tools\package-revivalside-mega-release.ps1"),
  "-RuntimeIdentifier", "win-x64",
  "-OutputDir", $appPayload,
  "-NodePath", (Resolve-NodeRuntime "win-x64")
)
if ($SkipWikiAssets) { $sharedArgs += "-SkipWikiAssets" }
& powershell @sharedArgs
if ($LASTEXITCODE -ne 0) {
  throw "Shared app payload build failed"
}

foreach ($relative in @(
  "RevivalSideLauncher.exe",
  "RevivalSideLauncher.pdb",
  "combat-host",
  "tools\CounterPassClientPatcher",
  "runtime",
  "Install RevivalSide.ps1",
  "Install RevivalSide.bat",
  "README.txt"
)) {
  Remove-IfPresent (Join-Path $appPayload $relative)
}
Remove-PdbFiles $appPayload
if (Test-Path -LiteralPath (Join-Path $appPayload "gameplay-jsons") -PathType Container) {
  Write-Host "Shared app payload includes optional legacy gameplay-jsons."
} else {
  Write-Host "Shared app payload has no gameplay-jsons; runtime tables load from installed CounterSide luac assets."
}

foreach ($rid in $RuntimeIdentifiers) {
  $arch = Get-RidArchitecture $rid
  $runtimeOut = Join-Path $payloadRoot "runtime-apps\$rid"
  New-Item -ItemType Directory -Force -Path $runtimeOut | Out-Null

  Write-Host "Publishing launcher/combat host for $rid"
  & powershell -NoProfile -ExecutionPolicy Bypass `
    -File (Join-Path $rootPath "tools\build-revivalside-launcher.ps1") `
    -RuntimeIdentifier $rid `
    -OutputDir $runtimeOut
  if ($LASTEXITCODE -ne 0) { throw "Launcher build failed for $rid" }
  Remove-PdbFiles $runtimeOut
  Assert-ExecutableArchitecture (Join-Path $runtimeOut "RevivalSideLauncher.exe") $arch "RevivalSideLauncher.exe"

  $combatOut = Join-Path $runtimeOut "combat-host"
  $combatRid = Get-CombatHostRid $rid
  $combatArch = Get-RidArchitecture $combatRid
  dotnet publish (Join-Path $rootPath "combat-host\CombatHost.csproj") `
    -c Release -r $combatRid --self-contained false `
    -p:DebugType=None -p:DebugSymbols=false --nologo `
    -o $combatOut
  if ($LASTEXITCODE -ne 0) { throw "CombatHost publish failed for $rid" }
  Assert-ExecutableArchitecture (Join-Path $combatOut "CombatHost.exe") $combatArch "CombatHost.exe"
  Copy-CombatHostOriginalLayout $combatOut

  $patcherOut = Join-Path $runtimeOut "tools\CounterPassClientPatcher"
  dotnet publish (Join-Path $rootPath "tools\CounterPassClientPatcher\CounterPassClientPatcher.csproj") `
    -c Release -r $rid --self-contained false `
    -p:DebugType=None -p:DebugSymbols=false --nologo `
    -o $patcherOut
  if ($LASTEXITCODE -ne 0) { throw "CounterSide client patcher publish failed for $rid" }
  Remove-PdbFiles $patcherOut
  Assert-ExecutableArchitecture (Join-Path $patcherOut "CounterPassClientPatcher.exe") $arch "CounterPassClientPatcher.exe"

  Write-Host "Staging runtime binaries for $rid"
  $nodeExe = Resolve-NodeRuntime $rid
  Copy-DirectoryClean (Split-Path -Parent $nodeExe) (Join-Path $payloadRoot "runtime-node\$rid")
  Copy-DirectoryClean (Resolve-PythonRuntime $rid) (Join-Path $payloadRoot "runtime-python\$rid")
  Copy-DirectoryClean (Resolve-WiresharkRuntime $rid) (Join-Path $payloadRoot "runtime-wireshark\$rid")
  Copy-InstallerFile (Resolve-DotNetRuntimeInstaller $rid) (Join-Path $payloadRoot "runtime-installers\dotnet\$rid")
}
Copy-InstallerFile (Resolve-NpcapInstaller) (Join-Path $payloadRoot "runtime-installers\npcap\all")

Write-Host "Publishing universal setup"
dotnet publish (Join-Path $rootPath "tools\RevivalSideInstallerApp\RevivalSideInstallerApp.csproj") `
  -c Release -r win-x86 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None -p:DebugSymbols=false --nologo `
  -o $outputPath
if ($LASTEXITCODE -ne 0) {
  throw "Setup publish failed"
}
Remove-PdbFiles $outputPath
Assert-ExecutableArchitecture (Join-Path $outputPath "RevivalSideSetup.exe") "x86" "RevivalSideSetup.exe"

@"
RevivalSide Universal Windows Installer

Run RevivalSideSetup.exe. The setup app detects the Windows architecture and
installs the matching launcher, combat host, client patcher, and bundled runtime
binaries.

Gameplay tables are derived from the user's installed encrypted CounterSide
script assets; no gameplay-jsons or decompiled gameplay table dump is bundled.
Launcher cutscene backgrounds are also derived from installed encrypted
CounterSide image assets; no cutscene background pack is bundled.

This folder intentionally stores app data once instead of producing separate
win-arm64, win-x64, and win-x86 release bundles.

Bundled runtime binaries are staged under runtime\ after setup:
- runtime\node contains Node.js and npm.
- runtime\python contains Python plus UnityPy/Pillow for asset extraction.
- runtime\Wireshark contains dumpcap/tshark for Cross Save live capture.

Bundled dependency installers are staged under runtime\installers:
- runtime\installers\dotnet contains .NET 8 Runtime installers.
- runtime\installers\npcap contains the Npcap driver installer used by Cross Save
  live packet capture when the driver is missing.
"@ | Set-Content -LiteralPath (Join-Path $outputPath "README.txt") -Encoding UTF8

Write-Host "Packaged $outputPath"
