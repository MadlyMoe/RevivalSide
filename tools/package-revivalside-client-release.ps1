param(
  [string]$SourceClientRoot = "",
  [string]$OutputDir = "",
  [int]$ChunkSizeMB = 1800,
  [int]$ExpectedChunkCount = 9,
  [string]$Repository = "MadlyMoe/RevivalSide-Client"
)

$ErrorActionPreference = "Stop"

$rootPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$prebuiltRoot = [System.IO.Path]::GetFullPath((Join-Path $rootPath "prebuilt"))
$prebuiltPrefix = $prebuiltRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not $SourceClientRoot) {
  $localArchiveRoot = Join-Path $env:LOCALAPPDATA "RevivalSide\frozen-client"
  $SourceClientRoot = Get-ChildItem -LiteralPath $localArchiveRoot -Directory -ErrorAction Stop |
    Where-Object {
      (Test-Path -LiteralPath (Join-Path $_.FullName "CounterSide.exe") -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $_.FullName "Data\Managed\Assembly-CSharp.dll") -PathType Leaf)
    } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $SourceClientRoot) { throw "No frozen RevivalSide client was found." }
$sourceRoot = [System.IO.Path]::GetFullPath($SourceClientRoot)

foreach ($required in @("CounterSide.exe", "Version.json", "Data\Managed\Assembly-CSharp.dll")) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $required) -PathType Leaf)) {
    throw "The source client is missing $required at $sourceRoot"
  }
}

$versionJson = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot "Version.json") | ConvertFrom-Json
$clientVersion = ([string]$versionJson.VersionCode).Trim()
if ($clientVersion -notmatch '^[A-Za-z0-9._-]+$') { throw "Version.json contains an invalid VersionCode: $clientVersion" }
$versionTag = $clientVersion -replace '^LIVE_', ''
$releaseTag = "v$versionTag"
$rootDirName = "CounterSide-$clientVersion"
$archiveName = "RevivalSideClient-$clientVersion.zip"
$manifestName = "RevivalSideClientManifest.json"

if (-not $OutputDir) { $OutputDir = Join-Path $prebuiltRoot "revivalside-client-release-$clientVersion" }
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
if ($outputPath -ne $prebuiltRoot -and -not $outputPath.StartsWith($prebuiltPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDir must stay under $prebuiltRoot; resolved OutputDir=$outputPath"
}
if ($outputPath -eq $prebuiltRoot) { throw "OutputDir must be a child directory of $prebuiltRoot" }
if ($ChunkSizeMB -lt 1 -or $ChunkSizeMB -ge 2048) { throw "ChunkSizeMB must be between 1 and 2047." }

if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Recurse -Force }
New-Item -ItemType Directory -Path $outputPath | Out-Null

$sourcePrefix = $sourceRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
Write-Host "Scanning client files..."
$files = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Where-Object {
  $relative = $_.FullName.Substring($sourcePrefix.Length)
  $relative -ne "revivalside-frozen-client.json" -and
  $relative -ne "steam_appid.txt" -and
  -not $relative.StartsWith("revivalside-disabled\", [System.StringComparison]::OrdinalIgnoreCase)
} | Sort-Object FullName
Write-Host ("Found {0:N0} distributable files." -f $files.Count)

$activeSteamFiles = $files | Where-Object { $_.Name -match '^steam_api.*\.dll$' -or $_.Name -ieq 'steam_appid.txt' }
if ($activeSteamFiles) {
  throw "The source client still contains active Steam bootstrap files: $($activeSteamFiles.FullName -join ', ')"
}

$contentBytes = [long](($files | Measure-Object Length -Sum).Sum)
$assemblyPath = Join-Path $sourceRoot "Data\Managed\Assembly-CSharp.dll"
Write-Host "Hashing the managed client assembly..."
$patchedAssemblySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $assemblyPath).Hash.ToLowerInvariant()
$sourceManifestPath = Join-Path $sourceRoot "revivalside-frozen-client.json"
$sourceManifest = if (Test-Path -LiteralPath $sourceManifestPath) {
  Get-Content -Raw -LiteralPath $sourceManifestPath | ConvertFrom-Json
} else { $null }
$originalAssemblySha256 = if ($sourceManifest -and ([string]$sourceManifest.AssemblySha256) -match '^[a-fA-F0-9]{64}$') {
  ([string]$sourceManifest.AssemblySha256).ToLowerInvariant()
} else { $patchedAssemblySha256 }

$distributionManifest = [ordered]@{
  DistributionSchemaVersion = 1
  ClientVersion = $clientVersion
  ArchivedAtUtc = [DateTime]::UtcNow.ToString("o")
  SourceRoot = ""
  RootDir = ""
  ManagedDir = "Data\Managed"
  FileCount = $files.Count + 1
  ByteCount = $contentBytes
  AssemblySha256 = $originalAssemblySha256
  PatchedAtUtc = $null
  PatchedAssemblySha256 = $patchedAssemblySha256
  SteamRuntimeIsolated = $true
}
$utf8 = [System.Text.UTF8Encoding]::new($false)
$distributionManifestText = ($distributionManifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine
$distributionManifestBytes = $utf8.GetBytes($distributionManifestText)
$installedSize = $contentBytes + $distributionManifestBytes.Length

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $outputPath $archiveName
Write-Host "Creating the uncompressed client archive..."
$archiveStream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
$zip = [System.IO.Compression.ZipArchive]::new($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
try {
  $index = 0
  $processedBytes = [long]0
  foreach ($file in $files) {
    if ($index -eq 0) { Write-Host "Archiving first file: $($file.FullName)" }
    $relative = $file.FullName.Substring($sourcePrefix.Length).Replace('\', '/')
    $entry = $zip.CreateEntry("$rootDirName/$relative", [System.IO.Compression.CompressionLevel]::NoCompression)
    $entryStream = $entry.Open()
    $input = [System.IO.File]::OpenRead($file.FullName)
    try { $input.CopyTo($entryStream, 8MB) }
    finally {
      $input.Dispose()
      $entryStream.Dispose()
    }
    $index += 1
    $processedBytes += $file.Length
    if (($index % 250) -eq 0) {
      Write-Host ("Archived {0:N0}/{1:N0} files ({2:N2} GiB)" -f $index, $files.Count, ($processedBytes / 1GB))
    }
  }
  $manifestEntry = $zip.CreateEntry("$rootDirName/revivalside-frozen-client.json", [System.IO.Compression.CompressionLevel]::NoCompression)
  $manifestStream = $manifestEntry.Open()
  try { $manifestStream.Write($distributionManifestBytes, 0, $distributionManifestBytes.Length) }
  finally { $manifestStream.Dispose() }
}
finally {
  $zip.Dispose()
  $archiveStream.Dispose()
}

$archiveItem = Get-Item -LiteralPath $archivePath
$archiveSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
$chunkSize = [long]$ChunkSizeMB * 1MB
$chunks = @()
$inputStream = [System.IO.File]::OpenRead($archivePath)
try {
  $buffer = New-Object byte[] (8MB)
  $chunkIndex = 0
  while ($inputStream.Position -lt $inputStream.Length) {
    $chunkIndex += 1
    $chunkName = "$archiveName.$($chunkIndex.ToString('000'))"
    $chunkPath = Join-Path $outputPath $chunkName
    $chunkStream = [System.IO.File]::Open($chunkPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $remaining = [Math]::Min($chunkSize, $inputStream.Length - $inputStream.Position)
      while ($remaining -gt 0) {
        $read = $inputStream.Read($buffer, 0, [int][Math]::Min($buffer.Length, $remaining))
        if ($read -le 0) { throw "Unexpected end of archive while writing $chunkName" }
        $chunkStream.Write($buffer, 0, $read)
        $remaining -= $read
      }
    }
    finally { $chunkStream.Dispose() }
    $chunkItem = Get-Item -LiteralPath $chunkPath
    $chunks += [ordered]@{
      name = $chunkName
      size = $chunkItem.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $chunkPath).Hash.ToLowerInvariant()
    }
    Write-Host ("Prepared {0} ({1:N2} GiB)" -f $chunkName, ($chunkItem.Length / 1GB))
  }
}
finally { $inputStream.Dispose() }

if ($chunks.Count -ne $ExpectedChunkCount) {
  throw "Expected exactly $ExpectedChunkCount chunks, but packaging produced $($chunks.Count). Adjust -ChunkSizeMB and rerun."
}
if ($chunks | Where-Object { $_.size -ge 2GB }) { throw "At least one release asset is 2 GiB or larger." }

$releaseManifest = [ordered]@{
  schemaVersion = 1
  clientVersion = $clientVersion
  rootDirName = $rootDirName
  archiveName = $archiveName
  archiveSize = $archiveItem.Length
  archiveSha256 = $archiveSha256
  installedSize = $installedSize
  fileCount = $files.Count + 1
  chunks = $chunks
}
$manifestPath = Join-Path $outputPath $manifestName
[System.IO.File]::WriteAllText($manifestPath, (($releaseManifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine), $utf8)
Remove-Item -LiteralPath $archivePath -Force

$commands = @"
# Run these commands in PowerShell from:
Set-Location '$outputPath'

# Create an unpublished release first so the launcher cannot see incomplete assets.
gh release create '$releaseTag' --repo '$Repository' --draft --title 'RevivalSide Client $clientVersion' --notes 'Studio Bside-authorized non-commercial RevivalSide client build $clientVersion.'

# Upload all nine chunks. Rerunning with --clobber is safe after a failed upload.
Get-ChildItem -LiteralPath . -File -Filter '$archiveName.*' | Sort-Object Name | ForEach-Object { gh release upload '$releaseTag' --repo '$Repository' --clobber `$_.FullName }

# Upload the manifest last, then publish and mark this release latest.
gh release upload '$releaseTag' --repo '$Repository' --clobber '.\$manifestName'
gh release edit '$releaseTag' --repo '$Repository' --draft=false --latest
"@
[System.IO.File]::WriteAllText((Join-Path $outputPath "UPLOAD-COMMANDS.ps1.txt"), ($commands.Trim() + [Environment]::NewLine), $utf8)

Write-Host ""
Write-Host "RevivalSide client release prepared successfully."
Write-Host "Output: $outputPath"
Write-Host "Version: $clientVersion"
Write-Host "Files: $($files.Count + 1)"
Write-Host ("Installed size: {0:N2} GiB" -f ($installedSize / 1GB))
Write-Host ("Upload size: {0:N2} GiB across {1} chunks" -f ($archiveItem.Length / 1GB), $chunks.Count)
Write-Host "Commands: $(Join-Path $outputPath 'UPLOAD-COMMANDS.ps1.txt')"
