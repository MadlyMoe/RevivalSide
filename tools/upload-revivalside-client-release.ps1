[CmdletBinding()]
param(
  [string]$Repository = "MadlyMoe/RevivalSide-Client",
  [switch]$KeepDraft,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$outputPath = [System.IO.Path]::GetFullPath($PSScriptRoot)
$manifestPath = Join-Path $outputPath "RevivalSideClientManifest.json"

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "RevivalSideClientManifest.json was not found next to this upload script."
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ([int]$manifest.schemaVersion -ne 1) { throw "Unsupported release manifest schema: $($manifest.schemaVersion)" }
if (-not $manifest.clientVersion) { throw "The release manifest has no clientVersion." }
if (-not $manifest.chunks -or $manifest.chunks.Count -ne 9) {
  throw "The release manifest must contain exactly nine chunks."
}

$versionTag = ([string]$manifest.clientVersion) -replace '^LIVE_', ''
if ($versionTag -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid client version: $($manifest.clientVersion)" }
$releaseTag = "v$versionTag"
$title = "RevivalSide Client $($manifest.clientVersion)"
$notes = "Studio Bside-authorized non-commercial RevivalSide client build $($manifest.clientVersion)."

$chunks = @($manifest.chunks | ForEach-Object {
  $file = Get-Item -LiteralPath (Join-Path $outputPath ([string]$_.name)) -ErrorAction Stop
  if ($file.Length -ne [long]$_.size) { throw "Size mismatch for $($file.Name). Run the packager again." }
  [pscustomobject]@{
    File = $file
    Size = [long]$_.size
    Sha256 = ([string]$_.sha256).ToLowerInvariant()
  }
})

$totalBytes = [long](($chunks | Measure-Object Size -Sum).Sum)
$verifiedBytes = [long]0
for ($index = 0; $index -lt $chunks.Count; $index += 1) {
  $chunk = $chunks[$index]
  $percent = [Math]::Floor(($verifiedBytes / $totalBytes) * 100)
  Write-Progress -Id 1 -Activity "Checking RevivalSide upload" -Status "Verifying chunk $($index + 1) of 9: $($chunk.File.Name)" -PercentComplete $percent
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $chunk.File.FullName).Hash.ToLowerInvariant()
  if ($actualHash -ne $chunk.Sha256) { throw "SHA-256 mismatch for $($chunk.File.Name). Run the packager again." }
  $verifiedBytes += $chunk.Size
}
Write-Progress -Id 1 -Activity "Checking RevivalSide upload" -Completed
Write-Host ("Verified nine chunks ({0:N2} GiB)." -f ($totalBytes / 1GB)) -ForegroundColor Green

if ($DryRun) {
  Write-Host "Dry run complete. No GitHub release was created or changed."
  exit 0
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) was not found. Install it and run gh auth login first."
}

function Invoke-GitHubCli {
  param([Parameter(Mandatory)][string[]]$Arguments)
  & gh @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI failed: gh $($Arguments -join ' ')"
  }
}

Invoke-GitHubCli -Arguments @("auth", "status")
$releaseJson = & gh release view $releaseTag --repo $Repository --json isDraft 2>$null
if ($LASTEXITCODE -eq 0) {
  $release = $releaseJson | ConvertFrom-Json
  if (-not $release.isDraft) {
    throw "Release $releaseTag is already published. This uploader only resumes draft releases."
  }
  Write-Host "Resuming draft release $releaseTag."
} else {
  Invoke-GitHubCli -Arguments @(
    "release", "create", $releaseTag,
    "--repo", $Repository,
    "--draft",
    "--title", $title,
    "--notes", $notes
  )
}

$uploadedBytes = [long]0
for ($index = 0; $index -lt $chunks.Count; $index += 1) {
  $chunk = $chunks[$index]
  $percent = [Math]::Floor(($uploadedBytes / $totalBytes) * 100)
  $status = "Chunk $($index + 1) of 9: $($chunk.File.Name)"
  Write-Progress -Id 1 -Activity "Uploading $title" -Status $status -PercentComplete $percent
  Write-Host ("[{0}/9] Uploading {1} ({2:N2} GiB)..." -f ($index + 1), $chunk.File.Name, ($chunk.Size / 1GB)) -ForegroundColor Cyan
  Invoke-GitHubCli -Arguments @(
    "release", "upload", $releaseTag,
    "--repo", $Repository,
    "--clobber",
    $chunk.File.FullName
  )
  $uploadedBytes += $chunk.Size
  $percent = [Math]::Floor(($uploadedBytes / $totalBytes) * 100)
  Write-Progress -Id 1 -Activity "Uploading $title" -Status "Uploaded chunk $($index + 1) of 9" -PercentComplete $percent
  Write-Host ("Overall upload: {0:N1}% ({1:N2} / {2:N2} GiB)" -f (($uploadedBytes / $totalBytes) * 100), ($uploadedBytes / 1GB), ($totalBytes / 1GB))
}

Write-Progress -Id 1 -Activity "Uploading $title" -Status "Uploading verified release manifest" -PercentComplete 99
Invoke-GitHubCli -Arguments @(
  "release", "upload", $releaseTag,
  "--repo", $Repository,
  "--clobber",
  $manifestPath
)

if ($KeepDraft) {
  Write-Progress -Id 1 -Activity "Uploading $title" -Completed
  Write-Host "Upload complete. Release $releaseTag remains a draft." -ForegroundColor Green
  exit 0
}

Invoke-GitHubCli -Arguments @("release", "edit", $releaseTag, "--repo", $Repository, "--draft=false", "--latest")
Write-Progress -Id 1 -Activity "Uploading $title" -Completed
Write-Host "Upload complete. Release $releaseTag is published and marked latest." -ForegroundColor Green
