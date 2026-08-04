param(
  [string]$OutputDir = "",
  [string]$UniversalInstallerDir = "",
  [string]$ReleaseTag = "",
  [string]$ReleaseTarget = "",
  [string]$ReleaseBaseUrl = "",
  [string]$StableTag = "launcher-latest",
  [string]$PythonPath = "",
  [switch]$SkipUniversalBuild,
  [switch]$Upload
)

$ErrorActionPreference = "Stop"

$rootPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$prebuiltRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath "prebuilt"))
$prebuiltPrefix = $prebuiltRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if (-not $OutputDir) { $OutputDir = Join-Path $prebuiltRoot "revivalside-github-release" }
if (-not $UniversalInstallerDir) { $UniversalInstallerDir = Join-Path $prebuiltRoot "revivalside-universal-installer" }
if (-not $ReleaseTag) {
  $packageJson = Get-Content -Raw -LiteralPath (Join-Path $rootPath "package.json") | ConvertFrom-Json
  $ReleaseTag = "v$($packageJson.version)"
}
if (-not $ReleaseTarget) { $ReleaseTarget = (& git -C $rootPath rev-parse HEAD).Trim() }

$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$universalPath = [System.IO.Path]::GetFullPath($UniversalInstallerDir)
foreach ($candidate in @($outputPath, $universalPath)) {
  if ($candidate -ne $prebuiltRoot -and -not $candidate.StartsWith($prebuiltPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release build paths must stay under $prebuiltRoot; resolved path=$candidate"
  }
}

function Resolve-GitHubRepository {
  foreach ($remoteName in @("RevivalSide", "origin")) {
    $remote = (& git -C $rootPath remote get-url $remoteName 2>$null)
    if ($remote -and $remote -match "github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)(\.git)?$") {
      return "$($Matches.owner)/$($Matches.repo)"
    }
  }
  throw "Could not detect the GitHub repository from git remotes."
}

function Get-CompatibleRelativePath([string]$BasePath, [string]$TargetPath) {
  $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $target = [System.IO.Path]::GetFullPath($TargetPath)
  $baseUri = New-Object System.Uri($base)
  $targetUri = New-Object System.Uri($target)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Remove-PdbFiles([string]$Directory) {
  Get-ChildItem -LiteralPath $Directory -File -Filter "*.pdb" -ErrorAction SilentlyContinue | Remove-Item -Force
}

function New-ComponentArchive(
  [string]$Id,
  [string]$Source,
  [string]$EntryPrefix,
  [string[]]$ExcludePrefixes = @()
) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Component source was not found: $Source" }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $temporaryPath = Join-Path $outputPath "$Id.tmp.zip"
  if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
  $zip = [System.IO.Compression.ZipFile]::Open($temporaryPath, [System.IO.Compression.ZipArchiveMode]::Create)
  $count = 0
  try {
    foreach ($file in (Get-ChildItem -LiteralPath $Source -Recurse -File | Sort-Object FullName)) {
      $relative = (Get-CompatibleRelativePath $Source $file.FullName).Replace('\', '/')
      $excluded = $false
      foreach ($prefix in $ExcludePrefixes) {
        $normalized = $prefix.Trim('/').Replace('\', '/')
        if ($relative -eq $normalized -or $relative.StartsWith("$normalized/", [System.StringComparison]::OrdinalIgnoreCase)) {
          $excluded = $true
          break
        }
      }
      if ($excluded -or $relative.Equals(".env", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
      $entryName = "$($EntryPrefix.Trim('/'))/$relative"
      $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [System.DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [System.TimeSpan]::Zero)
      $sourceStream = [System.IO.File]::OpenRead($file.FullName)
      $entryStream = $entry.Open()
      try { $sourceStream.CopyTo($entryStream) }
      finally {
        $entryStream.Dispose()
        $sourceStream.Dispose()
      }
      $count++
    }
  }
  finally {
    $zip.Dispose()
  }
  if ($count -eq 0) { throw "Component $Id had no files." }

  $sha256 = Get-FileSha256 $temporaryPath
  $name = "RevivalSide-$Id-$($sha256.Substring(0, 12)).zip"
  $path = Join-Path $outputPath $name
  Move-Item -LiteralPath $temporaryPath -Destination $path -Force
  $item = Get-Item -LiteralPath $path
  Write-Host ("Component {0}: {1:N2} MiB, {2} files" -f $Id, ($item.Length / 1MB), $count)
  return [ordered]@{ id = $Id; name = $name; size = $item.Length; sha256 = $sha256; url = ""; path = $path; upload = $true }
}

function Get-PreviousManifest([string]$Url) {
  try {
    $client = New-Object System.Net.WebClient
    try {
      $json = [System.Text.Encoding]::UTF8.GetString($client.DownloadData($Url)).TrimStart([char]0xFEFF)
    }
    finally {
      $client.Dispose()
    }
    $manifest = $json | ConvertFrom-Json
    if ($manifest.schemaVersion -eq 2) { return $manifest }
  }
  catch {
    Write-Host "No reusable component manifest found at $Url"
  }
  return $null
}

function Get-PreviousComponents($Manifest) {
  $byId = @{}
  if (-not $Manifest -or -not $Manifest.components) { return $byId }
  foreach ($group in $Manifest.components.PSObject.Properties) {
    foreach ($component in $group.Value) { $byId[[string]$component.id] = $component }
  }
  return $byId
}

function Test-GitHubRelease([string]$Tag, [string]$Repository) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & gh release view $Tag --repo $Repository *> $null
    return $LASTEXITCODE -eq 0
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Resolve-ComponentUrl($Component, $PreviousById, [string]$CurrentBaseUrl) {
  $previous = $PreviousById[$Component.id]
  if ($previous -and ([string]$previous.sha256).Equals($Component.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    $Component.url = [string]$previous.url
    $Component.upload = $false
    Write-Host "Reusing $($Component.id) from $($Component.url)"
  }
  else {
    $Component.url = "$CurrentBaseUrl/$($Component.name)"
  }
}

function Convert-ToManifestComponent($Component) {
  return [ordered]@{
    id = $Component.id
    name = $Component.name
    size = $Component.size
    sha256 = $Component.sha256
    url = $Component.url
  }
}

function Assert-ComponentArchives([array]$ComponentsByGroup) {
  Add-Type -AssemblyName System.IO.Compression
  $entries = @{}
  foreach ($component in $ComponentsByGroup) {
    if ((Get-FileSha256 $component.path) -ne $component.sha256) { throw "Component hash changed after packaging: $($component.id)" }
    $archive = [System.IO.Compression.ZipFile]::OpenRead($component.path)
    try {
      foreach ($entry in $archive.Entries) {
        $entries[$entry.FullName] = $true
        if ($entry.FullName -match '(^|/)\.env$') { throw "Secret .env was found in $($component.name)" }
        if ($entry.FullName -match '(?i)npcap[^/]*\.exe$') { throw "Npcap installer was found in $($component.name)" }
      }
    }
    finally { $archive.Dispose() }
  }
  foreach ($required in @(
    "payload/app/package.json",
    "payload/app/wiki/data/assets.json",
    "payload/app/server-data/users.json"
  )) {
    if (-not $entries[$required]) { throw "Component set is missing $required" }
  }
  foreach ($rid in @("win-arm64", "win-x64", "win-x86")) {
    foreach ($required in @(
      "payload/runtime-apps/$rid/RevivalSideLauncher.exe",
      "payload/runtime-node/$rid/node.exe",
      "payload/runtime-node/$rid/npm.cmd",
      "payload/runtime-python/$rid/python.exe",
      "payload/runtime-wireshark/$rid/dumpcap.exe",
      "payload/runtime-wireshark/$rid/tshark.exe"
    )) {
      if (-not $entries[$required]) { throw "Component set is missing $required" }
    }
    if (-not ($entries.Keys | Where-Object { $_ -like "payload/runtime-installers/dotnet/$rid/*.exe" } | Select-Object -First 1)) {
      throw "Component set is missing the .NET installer for $rid"
    }
  }
  Write-Host "Component archive validation passed."
}

$repository = Resolve-GitHubRepository
$versionReleaseBase = if ($ReleaseBaseUrl) { $ReleaseBaseUrl.TrimEnd('/') } else { "https://github.com/$repository/releases/download/$ReleaseTag" }
$stableReleaseBase = "https://github.com/$repository/releases/download/$StableTag"
$manifestName = "RevivalSideReleaseManifest.json"
$stableManifestUrl = "$stableReleaseBase/$manifestName"

if (-not $SkipUniversalBuild) {
  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $rootPath "tools\package-revivalside-universal-installer.ps1"),
    "-OutputDir", $universalPath
  )
  if ($PythonPath) { $arguments += @("-PythonPath", $PythonPath) }
  & powershell @arguments
  if ($LASTEXITCODE -ne 0) { throw "Universal installer packaging failed." }
}

$payloadRoot = Join-Path $universalPath "payload"
if (-not (Test-Path -LiteralPath $payloadRoot -PathType Container)) { throw "Payload folder was not found: $payloadRoot" }
if (Get-ChildItem -LiteralPath $payloadRoot -Recurse -Force -File -Filter ".env" -ErrorAction SilentlyContinue) {
  throw "Release payload contains a forbidden .env file."
}
if (Get-ChildItem -LiteralPath $payloadRoot -Recurse -File -Filter "npcap*.exe" -ErrorAction SilentlyContinue) {
  throw "Release payload contains a forbidden Npcap installer."
}

if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Recurse -Force }
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

$stableManifest = Get-PreviousManifest $stableManifestUrl
$previousById = Get-PreviousComponents $stableManifest
$common = @(
  (New-ComponentArchive "core" (Join-Path $payloadRoot "app") "payload/app" @("server-data", "wiki")),
  (New-ComponentArchive "game-data" (Join-Path $payloadRoot "app\server-data") "payload/app/server-data"),
  (New-ComponentArchive "wiki" (Join-Path $payloadRoot "app\wiki") "payload/app/wiki")
)
$platforms = [ordered]@{}
foreach ($rid in @("win-arm64", "win-x64", "win-x86")) {
  $platforms[$rid] = @(
    (New-ComponentArchive "apps-$rid" (Join-Path $payloadRoot "runtime-apps\$rid") "payload/runtime-apps/$rid"),
    (New-ComponentArchive "node-$rid" (Join-Path $payloadRoot "runtime-node\$rid") "payload/runtime-node/$rid"),
    (New-ComponentArchive "python-$rid" (Join-Path $payloadRoot "runtime-python\$rid") "payload/runtime-python/$rid"),
    (New-ComponentArchive "wireshark-$rid" (Join-Path $payloadRoot "runtime-wireshark\$rid") "payload/runtime-wireshark/$rid"),
    (New-ComponentArchive "dotnet-$rid" (Join-Path $payloadRoot "runtime-installers\dotnet\$rid") "payload/runtime-installers/dotnet/$rid")
  )
}
$allComponents = @($common) + @($platforms.Values | ForEach-Object { $_ })
Assert-ComponentArchives $allComponents
foreach ($component in $allComponents) { Resolve-ComponentUrl $component $previousById $versionReleaseBase }

Write-Host "Publishing reusable web setup with manifest URL: $stableManifestUrl"
dotnet publish (Join-Path $rootPath "tools\RevivalSideInstallerApp\RevivalSideInstallerApp.csproj") `
  -c Release -r win-x86 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None -p:DebugSymbols=false `
  "-p:RevivalSideReleaseManifestUrl=$stableManifestUrl" `
  --nologo -o $outputPath
if ($LASTEXITCODE -ne 0) { throw "Web setup publish failed." }
Remove-PdbFiles $outputPath
$setupPath = Join-Path $outputPath "RevivalSideSetup.exe"
$setupItem = Get-Item -LiteralPath $setupPath
$setupSha256 = Get-FileSha256 $setupPath
$setupChanged = -not $stableManifest -or -not $stableManifest.setup -or
  -not ([string]$stableManifest.setup.sha256).Equals($setupSha256, [System.StringComparison]::OrdinalIgnoreCase)

$manifestComponents = [ordered]@{ common = @($common | ForEach-Object { Convert-ToManifestComponent $_ }) }
foreach ($rid in $platforms.Keys) {
  $manifestComponents[$rid] = @($platforms[$rid] | ForEach-Object { Convert-ToManifestComponent $_ })
}
$manifest = [ordered]@{
  schemaVersion = 2
  payloadId = "revivalside-$ReleaseTag"
  releaseTag = $ReleaseTag
  setup = [ordered]@{
    name = "RevivalSideSetup.exe"
    size = $setupItem.Length
    sha256 = $setupSha256
    url = "$stableReleaseBase/RevivalSideSetup.exe"
  }
  components = $manifestComponents
}
$manifestPath = Join-Path $outputPath $manifestName
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$setupUrl = "$stableReleaseBase/RevivalSideSetup.exe"
@"
RevivalSide $ReleaseTag

Download and run RevivalSideSetup.exe:
$setupUrl

This release uses platform-specific, content-addressed components. Setup downloads
only the current Windows architecture. Unchanged runtimes are reused by hash on
later releases. Npcap is not redistributed; Cross Save opens npcap.com when the
capture driver is missing.

Included in this release:
- Mod:Side with its creator, loader, Asset:Side, Story:Side, Unit:Side, Combat:Side, and Spine 3.7 Studio apps.
- Multi-unit authoring with editable skills, appearances, collection/profile metadata, and MP3 voice bundles.
- Frozen/offline client, custom-unit CombatHost, progression, event, shop, and reward compatibility fixes.
- Cross Save capture/export/import and the lazy local RevivalSide Wiki.
- Clean upgrade receipts that remove obsolete managed files while preserving profiles, settings, captures, exports, and logs.
"@ | Set-Content -LiteralPath (Join-Path $outputPath "README.txt") -Encoding UTF8

if ($Upload) {
  $notesPath = Join-Path $outputPath "release-notes.md"
  @"
## RevivalSide $ReleaseTag

### Mod tools

- Added the Mod:Side home, creator, loader, mod editing/copying with collision-safe IDs, and specialized Asset:Side, Story:Side, Unit:Side, Combat:Side, and Spine 3.7 Studio apps.
- Rebuilt Unit:Side around complete playable unit creation: all employee, NPC, enemy, boss, ship, and BASE2 templates; multi-unit packs; existing-unit editing; skill, appearance, collection/profile, association, and voice-line editors; lazy previews; audio extraction; and MP3-to-voice-bundle conversion.
- Expanded Story:Side with CounterSide-style episode organization, editable existing episodes, project copying, cutscene/stage authoring, and dungeon-ID collision resolution.

### Runtime and launcher

- Made custom and duplicated units load consistently in CombatHost with movement, skills, skill bars/icons, voices, skins, and full-squad support, including boss-derived playable units.
- Added independent Mod:Side and Combat:Side service lifecycle, asset preparation progress, a Mod:Side home landing page, the updated Discord invite, and reliable log-folder opening.
- Added Cross Save capture/export/import, event login backgrounds, frozen-client controls, responsive launcher state/settings, and single-instance focus.

### Game and PC packaging

- Fixed Boss Raid duplicate handling plus tutorial/stage progression, squad loadouts, limit breaks, event shops, random-box rewards, and frozen-content compatibility.
- Added the lazy local wiki and content-addressed Windows components for x64, x86, and ARM64 while preserving profiles, settings, captures, exports, mods, and logs during upgrades.

**Installer:** [$setupUrl]($setupUrl)
"@ | Set-Content -LiteralPath $notesPath -Encoding UTF8

  if (-not (Test-GitHubRelease $ReleaseTag $repository)) {
    & gh release create $ReleaseTag --repo $repository --title "RevivalSide $ReleaseTag" --target $ReleaseTarget --draft --notes-file $notesPath
    if ($LASTEXITCODE -ne 0) { throw "Could not create release $ReleaseTag." }
  }
  if (-not (Test-GitHubRelease $StableTag $repository)) {
    & gh release create $StableTag --repo $repository --title "RevivalSide Windows Installer" --target $ReleaseTarget --prerelease --notes "Stable Windows setup bootstrap. The manifest and setup are updated only when their contents change."
    if ($LASTEXITCODE -ne 0) { throw "Could not create stable installer release $StableTag." }
  }

  $newAssets = @($allComponents | Where-Object { $_.upload } | ForEach-Object { $_.path })
  $newAssets += (Join-Path $outputPath "README.txt")
  if ($setupChanged) { $newAssets += $setupPath }
  if ($newAssets.Count -gt 0) {
    & gh release upload $ReleaseTag $newAssets --repo $repository --clobber
    if ($LASTEXITCODE -ne 0) { throw "Could not upload release component assets." }
  }
  if ($setupChanged) {
    & gh release upload $StableTag $setupPath --repo $repository --clobber
    if ($LASTEXITCODE -ne 0) { throw "Could not upload the stable setup executable." }
  }
  & gh release upload $StableTag $manifestPath --repo $repository --clobber
  if ($LASTEXITCODE -ne 0) { throw "Could not publish the stable release manifest." }
  & gh release upload $ReleaseTag $manifestPath --repo $repository --clobber
  if ($LASTEXITCODE -ne 0) { throw "Could not publish the version release manifest." }
  & gh release edit $ReleaseTag --repo $repository --draft=false --latest --notes-file $notesPath
  if ($LASTEXITCODE -ne 0) { throw "Could not publish release $ReleaseTag." }
}

Write-Host "Packaged component release assets at $outputPath"
