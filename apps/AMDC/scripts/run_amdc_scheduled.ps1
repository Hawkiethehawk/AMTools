param(
  [string]$ProjectDir = (Join-Path $PSScriptRoot '..'),
  [switch]$StartOnly
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path $ProjectDir).Path
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $ProjectDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'scheduled-run.log'

function Write-RunLog([string]$Message) {
  Add-Content -LiteralPath $LogFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
}

function Get-DashboardHealth {
  $port = if ($env:AMDC_PORT) { [string]$env:AMDC_PORT } else { '8787' }
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
  } catch {
    $null
  }
}

try {
  $port = if ($env:AMDC_PORT) { [string]$env:AMDC_PORT } else { '8787' }
  $health = Get-DashboardHealth
  if (-not $health -or $health.projectDir -ne $ProjectDir) {
    if ($health -and $health.projectDir -ne $ProjectDir) { throw "Port 8787 is used by another AMDC project: $($health.projectDir)" }
    $savedProjectDir = $env:AMDC_PROJECT_DIR
    $savedNoOpen = $env:AMDC_NO_OPEN
    $savedPort = $env:AMDC_PORT
    try {
      $env:AMDC_PROJECT_DIR = $ProjectDir
      $env:AMDC_NO_OPEN = '1'
      $env:AMDC_PORT = $port
      Start-Process -FilePath 'node' -ArgumentList (Join-Path $ScriptDir 'progress-server.js') -WorkingDirectory $ProjectDir -WindowStyle Hidden | Out-Null
    } finally {
      if ($null -ne $savedProjectDir) { $env:AMDC_PROJECT_DIR = $savedProjectDir } else { Remove-Item Env:AMDC_PROJECT_DIR -ErrorAction SilentlyContinue }
      if ($null -ne $savedNoOpen) { $env:AMDC_NO_OPEN = $savedNoOpen } else { Remove-Item Env:AMDC_NO_OPEN -ErrorAction SilentlyContinue }
      if ($null -ne $savedPort) { $env:AMDC_PORT = $savedPort } else { Remove-Item Env:AMDC_PORT -ErrorAction SilentlyContinue }
    }
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      $health = Get-DashboardHealth
      if ($health -and $health.projectDir -eq $ProjectDir) { break }
    }
    if (-not $health -or $health.projectDir -ne $ProjectDir) { throw 'Dashboard startup timed out before /api/health became available.' }
    Write-RunLog "Dashboard started headlessly, pid $($health.pid)"
  }

  if ($StartOnly) {
    Write-RunLog "StartOnly completed for project $ProjectDir"
    exit 0
  }

  $configPath = Join-Path $ProjectDir 'amdc-config.json'
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $token = [string]$config.schedule.apiToken
  if ($token.Length -lt 32) { throw 'Dashboard did not initialize the scheduled-run token.' }
  $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/run/scheduled" -Headers @{ 'X-AMDC-Token' = $token } -TimeoutSec 120
  if (-not $response.ok) { throw ([string]$response.error) }
  Write-RunLog "Scheduled collection submitted: $($response.run.job.batchId)"
} catch {
  Write-RunLog "Submission failed: $($_.Exception.Message)"
  throw
}
