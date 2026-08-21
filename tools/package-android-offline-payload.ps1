param(
  [string]$HostRoot = (Join-Path $PSScriptRoot "..\dist\CounterSide-Android-9.21.3352381-host"),
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\prebuilt\revivalside-android-offline-payload"),
  [switch]$Force
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$hostPath = (Resolve-Path -LiteralPath $HostRoot).Path
$manifestPath = Join-Path $hostPath "payload-manifest.json"
$mirrorManifestPath = Join-Path $hostPath "android-client\payload-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Android payload manifest is missing: $manifestPath"
}

$manifestBytes = [System.IO.File]::ReadAllBytes($manifestPath)
$manifest = [System.Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$files = @($manifest.files)
$declaredCount = [long]$manifest.fileCount
$declaredBytes = [long]$manifest.totalBytes
if ($manifest.schemaVersion -ne 1 -or
    -not $manifest.id -or
    $manifest.patchVersion -notmatch '^ANDROID_\d+$' -or
    $declaredCount -le 0 -or
    $declaredBytes -le 0 -or
    $files.Count -ne $declaredCount) {
  throw "Android payload manifest is invalid: $manifestPath"
}
if (Test-Path -LiteralPath $mirrorManifestPath -PathType Leaf) {
  $mirrorHash = (Get-FileHash -LiteralPath $mirrorManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($mirrorHash -ne $manifestHash) { throw "Android payload manifest copies do not match." }
}

$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
$sum = 0L
foreach ($record in $files) {
  $relative = "$($record.path)".Replace('\', '/')
  $parts = @($relative.Split('/'))
  if (-not $relative -or $relative.StartsWith('/') -or $parts -contains '' -or $parts -contains '.' -or $parts -contains '..' -or -not $seen.Add($relative)) {
    throw "Unsafe or duplicate Android payload path: $relative"
  }
  $size = [long]$record.size
  if ($size -lt 0 -or "$($record.sha256)" -notmatch '^[a-fA-F0-9]{64}$') {
    throw "Invalid Android payload record: $relative"
  }
  $source = Join-Path $hostPath ($relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
  if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or (Get-Item -LiteralPath $source).Length -ne $size) {
    throw "Android payload file is missing or has the wrong size: $relative"
  }
  if ($sum -gt [long]::MaxValue - $size) { throw "Android payload byte total overflowed." }
  $sum += $size
}
if ($sum -ne $declaredBytes) { throw "Android payload byte total is mismatched." }

$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$archiveName = "RevivalSide-Android-payload-$($manifest.patchVersion)-$($manifestHash.Substring(0, 12)).zip"
$archivePath = Join-Path $outputRoot $archiveName
$temporaryPath = "$archivePath.tmp"
$metadataPath = [System.IO.Path]::ChangeExtension($archivePath, ".json")
foreach ($path in @($archivePath, $temporaryPath, $metadataPath)) {
  if (Test-Path -LiteralPath $path) {
    if (-not $Force) { throw "Output already exists; pass -Force to replace it: $path" }
    Remove-Item -LiteralPath $path -Force
  }
}

$drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($outputRoot))
$requiredFree = $declaredBytes + 256L * 1024L * 1024L
if ($drive.AvailableFreeSpace -lt $requiredFree) {
  throw "Not enough free space to package the payload. Need $requiredFree bytes; have $($drive.AvailableFreeSpace)."
}

$timestamp = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
$buffer = [byte[]]::new(1024 * 1024)
$archiveStream = [System.IO.File]::Open($temporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
  $archive = [System.IO.Compression.ZipArchive]::new($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    function Add-BytesEntry([string]$Name, [byte[]]$Bytes) {
      $entry = $archive.CreateEntry($Name, [System.IO.Compression.CompressionLevel]::NoCompression)
      $entry.LastWriteTime = $timestamp
      $stream = $entry.Open()
      try { $stream.Write($Bytes, 0, $Bytes.Length) } finally { $stream.Dispose() }
    }

    Add-BytesEntry "payload-manifest.json" $manifestBytes
    Add-BytesEntry "android-client/payload-manifest.json" $manifestBytes

    $index = 0L
    foreach ($record in @($files | Sort-Object path)) {
      $relative = "$($record.path)".Replace('\', '/')
      $source = Join-Path $hostPath ($relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
      $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::NoCompression)
      $entry.LastWriteTime = $timestamp
      $input = [System.IO.File]::OpenRead($source)
      $output = $entry.Open()
      $hash = [System.Security.Cryptography.IncrementalHash]::CreateHash([System.Security.Cryptography.HashAlgorithmName]::SHA256)
      $copied = 0L
      try {
        while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $output.Write($buffer, 0, $count)
          $hash.AppendData($buffer, 0, $count)
          $copied += [long]$count
        }
        $actualHash = [System.BitConverter]::ToString($hash.GetHashAndReset()).Replace('-', '').ToLowerInvariant()
      } finally {
        $hash.Dispose()
        $output.Dispose()
        $input.Dispose()
      }
      if ($copied -ne [long]$record.size -or $actualHash -ne "$($record.sha256)".ToLowerInvariant()) {
        throw "Android payload source changed while packaging: $relative"
      }
      $index += 1
      if ($index % 100 -eq 0 -or $index -eq $declaredCount) {
        Write-Progress -Activity "Packaging RevivalSide Android payload" -Status "$index / $declaredCount files" -PercentComplete ([int](100 * $index / $declaredCount))
      }
    }
    Write-Progress -Activity "Packaging RevivalSide Android payload" -Completed
  } finally {
    $archive.Dispose()
  }
} catch {
  $archiveStream.Dispose()
  Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  throw
} finally {
  $archiveStream.Dispose()
}

Move-Item -LiteralPath $temporaryPath -Destination $archivePath
$archiveSize = (Get-Item -LiteralPath $archivePath).Length
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[ordered]@{
  schemaVersion = 1
  archiveName = $archiveName
  archiveSize = $archiveSize
  archiveSha256 = $archiveHash
  payloadManifestSha256 = $manifestHash
  payloadId = "$($manifest.id)"
  packageName = "$($manifest.packageName)"
  versionName = "$($manifest.versionName)"
  versionCode = [long]$manifest.versionCode
  patchVersion = "$($manifest.patchVersion)"
  fileCount = $declaredCount
  totalBytes = $declaredBytes
} | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8

Write-Host "Android offline payload ready: $archivePath"
Write-Host "SHA256: $archiveHash"
