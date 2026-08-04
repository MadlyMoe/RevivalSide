$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this one-time cleanup from an elevated PowerShell prompt."
  }
}

Assert-Admin

$hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$markerStart = "# BEGIN RevivalSide"
$markerEnd = "# END RevivalSide"
$content = if (Test-Path -LiteralPath $hostsPath) {
  [System.IO.File]::ReadAllText($hostsPath)
} else {
  ""
}

$pattern = "(?ms)^$([regex]::Escape($markerStart)).*?^$([regex]::Escape($markerEnd))\r?\n?"
$updated = [regex]::Replace($content, $pattern, "")
if ($updated -eq $content) {
  Write-Host "[hosts] no legacy RevivalSide block was found"
  exit 0
}

$backupPath = "$hostsPath.revivalside-cleanup.$(Get-Date -Format yyyyMMddHHmmss).bak"
Copy-Item -LiteralPath $hostsPath -Destination $backupPath -Force

$directory = Split-Path -Parent $hostsPath
$fileName = Split-Path -Leaf $hostsPath
$tmpPath = Join-Path $directory ".$fileName.revivalside.tmp"
[System.IO.File]::WriteAllText($tmpPath, $updated, [System.Text.Encoding]::ASCII)
Move-Item -LiteralPath $tmpPath -Destination $hostsPath -Force

Write-Host "[hosts] removed legacy RevivalSide block from $hostsPath"
Write-Host "[hosts] backup $backupPath"
try {
  ipconfig /flushdns | Out-Null
  Write-Host "[hosts] dns cache flushed"
} catch {
  Write-Warning "[hosts] dns cache flush failed: $($_.Exception.Message)"
}
