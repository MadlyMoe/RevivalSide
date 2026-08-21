param(
  [string]$PayloadApp = (Join-Path $PSScriptRoot "..\prebuilt\revivalside-universal-installer\payload\app")
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$app = (Resolve-Path -LiteralPath $PayloadApp).Path
$repoPrefix = $repo.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$appPrefix = $app.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if (-not $app.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Generated payload must stay inside the RevivalSide workspace: $app"
}

function Get-CanonicalListenerFingerprint {
  $records = @()
  foreach ($name in @("server", "modules", "packet-handlers", "combat-handler", "stages")) {
    $source = Join-Path $repo $name
    $records += Get-ChildItem -LiteralPath $source -Recurse -File | ForEach-Object {
      $relative = $_.FullName.Substring($repo.Length + 1).Replace('\', '/')
      "$relative|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
    }
  }
  foreach ($name in @("cs-listener.js", "package.json", "packet-schema.json")) {
    $path = Join-Path $repo $name
    $records += "$name|$((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant())"
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes((($records | Sort-Object) -join "`n"))
  return [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  ).Replace("-", "").ToLowerInvariant()
}

$sourceFingerprintBefore = Get-CanonicalListenerFingerprint

foreach ($name in @("server", "modules", "packet-handlers", "combat-handler", "stages")) {
  $source = Join-Path $repo $name
  $destination = Join-Path $app $name
  $destinationFull = [System.IO.Path]::GetFullPath($destination)
  if (-not $destinationFull.StartsWith($appPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe generated payload destination: $destinationFull"
  }
  if (Test-Path -LiteralPath $destinationFull) {
    Remove-Item -LiteralPath $destinationFull -Recurse -Force
  }
  Copy-Item -LiteralPath $source -Destination $destinationFull -Recurse -Force
}

foreach ($name in @("cs-listener.js", "package.json", "packet-schema.json")) {
  Copy-Item -LiteralPath (Join-Path $repo $name) -Destination (Join-Path $app $name) -Force
}

$sourceFingerprintAfter = Get-CanonicalListenerFingerprint
if ($sourceFingerprintAfter -ne $sourceFingerprintBefore) {
  throw "Canonical listener changed during payload sync; rerun after the source tree is stable."
}

Write-Host "Synced canonical PC listener sources into generated payload: $app (fingerprint $sourceFingerprintAfter)"
