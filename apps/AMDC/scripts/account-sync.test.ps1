$ErrorActionPreference = 'Stop'

$sourcePath = Join-Path $PSScriptRoot 'sync-account-profiles.ps1'
$sourceText = Get-Content -LiteralPath $sourcePath -Raw
if (-not $sourceText.Contains('Invoke-AccountCacheCleanup') -or
    $sourceText.IndexOf('Invoke-AccountCacheCleanup', $sourceText.IndexOf('# ── 主流程 ──')) -lt 0) {
  throw 'The daily account sync does not invoke Chromium cache cleanup.'
}
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $sourcePath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count) {
  throw ($parseErrors | Out-String)
}

$functionAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Sync-Staging'
}, $true)
if (-not $functionAst) {
  throw 'Sync-Staging function not found.'
}
Invoke-Expression $functionAst.Extent.Text

$testRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'Cache\account-sync-isolated-test'
if (Test-Path -LiteralPath $testRoot) {
  throw "Isolated test directory already exists: $testRoot"
}

function Write-SyncLog([string]$Message) {}

try {
  $script:ProjectDir = $testRoot
  $script:StagingDir = Join-Path $testRoot 'Cache\account-sync-staging'
  New-Item -ItemType Directory -Force -Path $script:StagingDir | Out-Null

  $profiles = @('.amdc-userdata', '.amdc-userdata-b')
  foreach ($profile in $profiles) {
    $source = Join-Path $testRoot $profile
    New-Item -ItemType Directory -Force -Path @(
      (Join-Path $source 'Default\Network'),
      (Join-Path $source 'Default\Cache')
    ) | Out-Null
    Set-Content -LiteralPath (Join-Path $source 'amdc-token.json') -Value "token-$profile" -NoNewline
    Set-Content -LiteralPath (Join-Path $source 'Default\Network\Cookies') -Value "cookies-$profile" -NoNewline
    Set-Content -LiteralPath (Join-Path $source 'Default\Cache\discard.bin') -Value 'cache' -NoNewline

    $oldBackup = Join-Path $script:StagingDir $profile
    New-Item -ItemType Directory -Force -Path $oldBackup | Out-Null
    Set-Content -LiteralPath (Join-Path $oldBackup 'stale.txt') -Value 'stale' -NoNewline
  }

  $cleanupResult = & (Join-Path $PSScriptRoot 'cleanup-account-caches.ps1') -ProjectDir $testRoot
  if ($cleanupResult.directories -ne 2 -or $cleanupResult.reclaimableBytes -le 0) {
    throw 'Account cache cleanup summary is invalid.'
  }
  foreach ($profile in $profiles) {
    $source = Join-Path $testRoot $profile
    if (Test-Path -LiteralPath (Join-Path $source 'Default\Cache')) {
      throw "$profile retained a rebuildable cache directory."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $source 'Default\Network\Cookies')) -or
        -not (Test-Path -LiteralPath (Join-Path $source 'amdc-token.json'))) {
      throw "$profile cleanup removed login state."
    }
  }

  $failedAsExpected = $false
  try {
    Sync-Staging -OkDirs @('.amdc-userdata', '.amdc-userdata-missing') -BackupTimestamp '2026-08-13T00:00:00.0000000Z'
  } catch {
    $failedAsExpected = $true
  }
  if (-not $failedAsExpected) {
    throw 'An incomplete backup build did not fail.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $script:StagingDir '.amdc-userdata\stale.txt'))) {
    throw 'An incomplete backup build changed an existing backup.'
  }

  $timestamp = '2026-08-13T01:23:45.0000000Z'
  Sync-Staging -OkDirs $profiles -BackupTimestamp $timestamp

  foreach ($profile in $profiles) {
    $backup = Join-Path $script:StagingDir $profile
    if (Test-Path -LiteralPath (Join-Path $backup 'stale.txt')) {
      throw "$profile retained a stale file."
    }
    if (Test-Path -LiteralPath (Join-Path $backup 'Default\Cache')) {
      throw "$profile copied an excluded cache directory."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $backup 'Default\Network\Cookies'))) {
      throw "$profile did not copy the current login state."
    }

    $metadata = Get-Content -LiteralPath (Join-Path $backup '.amdc-backup.json') -Raw | ConvertFrom-Json
    $metadataTimestamp = ([datetime]$metadata.backedUpAt).ToUniversalTime().ToString('o')
    if ($metadata.profile -ne $profile -or
        $metadata.authStatus -ne 'OK' -or
        $metadataTimestamp -ne $timestamp) {
      throw "$profile backup metadata is invalid."
    }
  }

  Write-Output 'account sync isolated test ok'
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
