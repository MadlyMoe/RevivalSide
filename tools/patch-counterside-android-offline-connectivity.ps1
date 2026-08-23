param(
  [string]$DecodedDirectory = "",
  [string]$ApkDirectory = ""
)

$ErrorActionPreference = "Stop"
if ([bool]$DecodedDirectory -eq [bool]$ApkDirectory) {
  throw "Pass exactly one of -DecodedDirectory or -ApkDirectory."
}

$nativePatches = @{
  "arm64-v8a" = [ordered]@{
    offset = [long]0x3FA9224
    original = [byte[]](0xFE, 0x4F, 0xBF, 0xA9, 0x73, 0x3E, 0x00, 0xB0)
    patched = [byte[]](0x40, 0x00, 0x80, 0x52, 0xC0, 0x03, 0x5F, 0xD6)
  }
  "armeabi-v7a" = [ordered]@{
    offset = [long]0x38D3000
    original = [byte[]](0x00, 0x48, 0x2D, 0xE9, 0x28, 0x00, 0x9F, 0xE5)
    patched = [byte[]](0x02, 0x00, 0xA0, 0xE3, 0x1E, 0xFF, 0x2F, 0xE1)
  }
}

function Set-ExpectedBytes {
  param(
    [Parameter(Mandatory = $true)]
    [byte[]]$Bytes,
    [Parameter(Mandatory = $true)]
    [long]$Offset,
    [Parameter(Mandatory = $true)]
    [byte[]]$Original,
    [Parameter(Mandatory = $true)]
    [byte[]]$Patched,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if ($Offset -lt 0 -or $Offset + $Original.Length -gt $Bytes.LongLength) {
    throw "$Label is too short for the frozen connectivity patch at 0x$($Offset.ToString('X'))."
  }

  $originalMatch = $true
  $patchedMatch = $true
  for ($index = 0; $index -lt $Original.Length; $index++) {
    if ($Bytes[$Offset + $index] -ne $Original[$index]) { $originalMatch = $false }
    if ($Bytes[$Offset + $index] -ne $Patched[$index]) { $patchedMatch = $false }
  }
  if ($patchedMatch) { return $false }
  if (-not $originalMatch) {
    $actual = [BitConverter]::ToString($Bytes[$Offset..($Offset + $Original.Length - 1)]).Replace("-", "")
    throw "$Label does not match the frozen 9.21.3352381 connectivity method at 0x$($Offset.ToString('X')); found $actual."
  }

  [System.Array]::Copy($Patched, 0, $Bytes, $Offset, $Patched.Length)
  return $true
}

function Set-NativeConnectivityPatch {
  param(
    [Parameter(Mandatory = $true)]
    [byte[]]$Bytes,
    [Parameter(Mandatory = $true)]
    [string]$Abi,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if (-not $nativePatches.ContainsKey($Abi)) { return $false }
  $patch = $nativePatches[$Abi]
  return Set-ExpectedBytes -Bytes $Bytes -Offset $patch.offset -Original $patch.original -Patched $patch.patched -Label $Label
}

function Set-GamebaseNetworkPlugin {
  param([Parameter(Mandatory = $true)][string]$Root)

  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -Filter "GamebaseNetworkPlugin.smali" -File |
    Where-Object { $_.FullName -match '[\\/]com[\\/]toast[\\/]android[\\/]gamebase[\\/]plugin[\\/]GamebaseNetworkPlugin\.smali$' })
  if ($files.Count -ne 1) {
    throw "Expected one GamebaseNetworkPlugin.smali; found $($files.Count)."
  }

  $smali = [System.IO.File]::ReadAllText($files[0].FullName)
  $overrides = [ordered]@{
    getType = @'
.method private getType(Ljava/lang/String;Lcom/toast/android/gamebase/plugin/communicator/GamebaseListener;)Ljava/lang/String;
    .locals 1
    const-string v0, "1"
    return-object v0
.end method
'@
    getTypeName = @'
.method private getTypeName(Ljava/lang/String;Lcom/toast/android/gamebase/plugin/communicator/GamebaseListener;)Ljava/lang/String;
    .locals 1
    const-string v0, "wifi"
    return-object v0
.end method
'@
    isConnected = @'
.method private isConnected(Ljava/lang/String;Lcom/toast/android/gamebase/plugin/communicator/GamebaseListener;)Ljava/lang/String;
    .locals 1
    const-string v0, "{\"isConnected\":true}"
    return-object v0
.end method
'@
  }

  foreach ($methodName in $overrides.Keys) {
    $pattern = '(?s)\.method private ' + [regex]::Escape($methodName) + '\(Ljava/lang/String;Lcom/toast/android/gamebase/plugin/communicator/GamebaseListener;\)Ljava/lang/String;.*?\.end method'
    if ([regex]::Matches($smali, $pattern).Count -ne 1) {
      throw "Expected one Gamebase network $methodName method."
    }
    $replacement = $overrides[$methodName].Trim()
    $smali = [regex]::Replace($smali, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement }, 1)
  }

  [System.IO.File]::WriteAllText($files[0].FullName, $smali, [System.Text.UTF8Encoding]::new($false))
}

if ($DecodedDirectory) {
  $decoded = Resolve-Path -LiteralPath $DecodedDirectory
  Set-GamebaseNetworkPlugin -Root $decoded

  $nativeCount = 0
  foreach ($abi in $nativePatches.Keys) {
    $path = Join-Path $decoded "lib\$abi\libil2cpp.so"
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    if (Set-NativeConnectivityPatch -Bytes $bytes -Abi $abi -Label $path) {
      [System.IO.File]::WriteAllBytes($path, $bytes)
    }
    $nativeCount++
  }
  Write-Host "Patched Gamebase connectivity and $nativeCount decoded IL2CPP ABI(s)."
  return
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$apkRoot = Resolve-Path -LiteralPath $ApkDirectory
$nativeCount = 0
foreach ($apk in Get-ChildItem -LiteralPath $apkRoot -Filter "*.apk" -File -Recurse) {
  $zip = [System.IO.Compression.ZipFile]::Open($apk.FullName, [System.IO.Compression.ZipArchiveMode]::Update)
  try {
    foreach ($abi in $nativePatches.Keys) {
      $entryName = "lib/$abi/libil2cpp.so"
      $entry = $zip.GetEntry($entryName)
      if (-not $entry) { continue }

      $memory = New-Object System.IO.MemoryStream
      $stream = $entry.Open()
      try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
      $bytes = $memory.ToArray()
      $memory.Dispose()
      $changed = Set-NativeConnectivityPatch -Bytes $bytes -Abi $abi -Label "$($apk.Name):$entryName"
      if ($changed) {
        $entry.Delete()
        $replacement = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::NoCompression)
        $stream = $replacement.Open()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
      }
      $nativeCount++
    }
  } finally {
    $zip.Dispose()
  }
}
if ($nativeCount -eq 0) { throw "No supported IL2CPP ABI was found under $apkRoot." }
Write-Host "Patched $nativeCount packaged IL2CPP ABI(s)."
