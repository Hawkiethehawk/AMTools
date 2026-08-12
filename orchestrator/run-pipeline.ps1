[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [ValidateSet('collect', 'analyze', 'pipeline')]
  [string]$Mode = 'pipeline',

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resolvedManifest = (Resolve-Path $ManifestPath).Path
$validator = Join-Path $repoRoot 'tests\validate-manifest.js'

& node $validator $resolvedManifest
if ($LASTEXITCODE -ne 0) {
  throw "CollectionManifest validation failed: $resolvedManifest"
}

$manifest = Get-Content -LiteralPath $resolvedManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Mode -ne 'analyze' -and $manifest.source -eq 'scheduled' -and -not $DryRun) {
  throw 'Real scheduled execution is not enabled in the initial AMTools orchestrator.'
}

$modeLabel = if ($DryRun) { 'dry-run' } else { $Mode }
Write-Output ("AMTools pipeline validated: mode={0}; batch={1}; status={2}" -f $modeLabel, $manifest.batchId, $manifest.status)
