[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ProjectDir = (Join-Path $PSScriptRoot '..'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$cacheNames = @(
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
  'GPUPersistentCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache',
  'component_crx_cache', 'extensions_crx_cache', 'Crashpad', 'BrowserMetrics',
  'AutofillAiModelCache', 'Safe Browsing', 'segmentation_platform',
  'Service Worker', 'Sessions'
)

$busyProfiles = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '^(chrome|msedge|chromium)\.exe$' -and
    $_.CommandLine -match '\.amdc-userdata'
})
if ($busyProfiles.Count) {
  throw "AMDC Chromium profiles are in use by $($busyProfiles.Count) process(es)."
}

$profiles = @(Get-ChildItem -LiteralPath $ProjectDir -Force -Directory | Where-Object {
  $_.Name -match '^\.amdc-userdata(-.+)?$'
} | Sort-Object Name)

$targets = @()
foreach ($profile in $profiles) {
  $profileRoot = [System.IO.Path]::GetFullPath($profile.FullName).TrimEnd('\')
  $candidates = @(Get-ChildItem -LiteralPath $profileRoot -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $cacheNames -contains $_.Name })
  $topTargets = @($candidates | Where-Object {
    $candidatePath = [System.IO.Path]::GetFullPath($_.FullName)
    -not ($candidates | Where-Object {
      $ancestorPath = [System.IO.Path]::GetFullPath($_.FullName).TrimEnd('\')
      $candidatePath -ne $ancestorPath -and
        $candidatePath.StartsWith($ancestorPath + '\', [System.StringComparison]::OrdinalIgnoreCase)
    })
  })

  foreach ($target in $topTargets) {
    $targetPath = [System.IO.Path]::GetFullPath($target.FullName)
    if ($targetPath -eq $profileRoot -or
        -not $targetPath.StartsWith($profileRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Unsafe cache cleanup target: $targetPath"
    }
    $files = @(Get-ChildItem -LiteralPath $targetPath -Recurse -Force -File -ErrorAction SilentlyContinue)
    $targets += [pscustomobject]@{
      Profile = $profile.Name
      Path = $targetPath
      Files = $files.Count
      Bytes = [long](($files | Measure-Object Length -Sum).Sum)
    }
  }
}

$totalBytes = [long](($targets | Measure-Object Bytes -Sum).Sum)
if (-not $DryRun) {
  foreach ($target in $targets) {
    if ($PSCmdlet.ShouldProcess($target.Path, 'remove rebuildable Chromium cache')) {
      Remove-Item -LiteralPath $target.Path -Recurse -Force
    }
  }
}

[pscustomobject]@{
  dryRun = [bool]$DryRun
  profiles = $profiles.Count
  directories = $targets.Count
  files = [long](($targets | Measure-Object Files -Sum).Sum)
  reclaimedBytes = if ($DryRun) { 0 } else { $totalBytes }
  reclaimableBytes = $totalBytes
  reclaimableMiB = [math]::Round($totalBytes / 1MB, 2)
}
