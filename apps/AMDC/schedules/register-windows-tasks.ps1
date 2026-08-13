[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ProjectDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path,
  [Alias('PwshPath')]
  [string]$PowerShellPath = '',
  [switch]$CheckOnly,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path

function Resolve-PowerShellRuntime([string]$RequestedPath) {
  $configuredTaskRuntime = try {
    @('AMDC Weekly', 'AMDC Account Sync') |
      ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue } |
      ForEach-Object { @($_.Actions)[0].Execute } |
      Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
      Select-Object -First 1
  } catch { $null }
  $configuredPowerShell7 = if ([System.IO.Path]::GetFileName([string]$configuredTaskRuntime) -ieq 'pwsh.exe') {
    $configuredTaskRuntime
  }
  $configuredWindowsPowerShell = if ($configuredTaskRuntime -and -not $configuredPowerShell7) {
    $configuredTaskRuntime
  }
  $candidates = @(
    $RequestedPath,
    $env:AMDC_POWERSHELL,
    $configuredPowerShell7,
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe' }),
    $(if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' }),
    $(try { (Get-Command pwsh.exe -ErrorAction Stop | Select-Object -First 1).Source } catch { $null }),
    $configuredWindowsPowerShell,
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
    $(if ($PSVersionTable.PSEdition -eq 'Desktop') { Join-Path $PSHOME 'powershell.exe' })
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique

  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $versionText = & $candidate -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'
    if ($LASTEXITCODE -ne 0 -or -not $versionText) { continue }
    $version = [version]([string]$versionText).Trim()
    if ($version -ge [version]'5.1') {
      return [pscustomobject]@{ Path = (Resolve-Path -LiteralPath $candidate).Path; Version = $version }
    }
  }
  throw 'PowerShell 7 or Windows PowerShell 5.1 is required for scheduled tasks.'
}

$runtime = Resolve-PowerShellRuntime $PowerShellPath
$PowerShellPath = $runtime.Path
$version = $runtime.Version

$definitions = @(
  [pscustomobject]@{
    TaskName = 'AMDC Account Sync'
    Template = Join-Path $PSScriptRoot 'account-sync.xml'
    Script = Join-Path $ProjectDir 'scripts\sync-account-profiles.ps1'
  },
  [pscustomobject]@{
    TaskName = 'AMDC Weekly'
    Template = Join-Path $PSScriptRoot 'weekly-run.xml'
    Script = Join-Path $ProjectDir 'scripts\run_amdc_scheduled.ps1'
  }
)

function Get-TaskReport {
  param([Parameter(Mandatory = $true)]$Definition)

  $expectedArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($Definition.Script)`" -ProjectDir `"$ProjectDir`""
  try {
    $task = Get-ScheduledTask -TaskName $Definition.TaskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $Definition.TaskName -ErrorAction Stop
    $action = @($task.Actions)[0]
    $hasRun = $info.LastRunTime -and $info.LastRunTime -ne [datetime]::MinValue
    $lastResult = [uint32]$info.LastTaskResult
    $checks = [ordered]@{
      exists = $true
      enabled = [bool]$task.Settings.Enabled
      powershellPath = [string]::Equals([string]$action.Execute, $PowerShellPath, [System.StringComparison]::OrdinalIgnoreCase)
      arguments = [string]::Equals([string]$action.Arguments, $expectedArguments, [System.StringComparison]::Ordinal)
      workingDirectory = [string]::Equals([string]$action.WorkingDirectory, $ProjectDir, [System.StringComparison]::OrdinalIgnoreCase)
      interactiveToken = [string]$task.Principal.LogonType -eq 'Interactive'
      lastRun = (-not $hasRun) -or $lastResult -eq 0
    }
    $configurationHealthy = @(
      $checks.exists,
      $checks.enabled,
      $checks.powershellPath,
      $checks.arguments,
      $checks.workingDirectory,
      $checks.interactiveToken
    ) -notcontains $false
    $healthy = $configurationHealthy -and $checks.lastRun
    [pscustomobject]@{
      taskName = $Definition.TaskName
      healthy = $healthy
      configurationHealthy = $configurationHealthy
      state = [string]$task.State
      execute = [string]$action.Execute
      arguments = [string]$action.Arguments
      workingDirectory = [string]$action.WorkingDirectory
      logonType = [string]$task.Principal.LogonType
      runLevel = [string]$task.Principal.RunLevel
      lastRunTime = if ($hasRun) { $info.LastRunTime.ToString('o') } else { '' }
      lastTaskResult = [long]$lastResult
      lastTaskResultHex = ('0x{0:X8}' -f $lastResult)
      nextRunTime = if ($info.NextRunTime -and $info.NextRunTime -ne [datetime]::MinValue) { $info.NextRunTime.ToString('o') } else { '' }
      checks = [pscustomobject]$checks
    }
  } catch {
    [pscustomobject]@{
      taskName = $Definition.TaskName
      healthy = $false
      configurationHealthy = $false
      state = 'missing'
      error = $_.Exception.Message
      checks = [pscustomobject]@{ exists = $false }
    }
  }
}

if ($CheckOnly) {
  $reports = @($definitions | ForEach-Object { Get-TaskReport $_ })
  $interactiveUser = ''
  try { $interactiveUser = [string](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName } catch {}
  $result = [pscustomobject]@{
    ok = @($reports | Where-Object { -not $_.healthy }).Count -eq 0
    projectDir = $ProjectDir
    powershellPath = $PowerShellPath
    powershellVersion = $version.ToString()
    prefersPowerShell7 = $true
    interactiveUser = $interactiveUser
    requiresLoggedInUser = $true
    tasks = $reports
  }
  if ($Json) { $result | ConvertTo-Json -Depth 8 }
  else {
    Write-Output ("AMDC schedule doctor: {0}" -f $(if ($result.ok) { 'PASS' } else { 'FAIL' }))
    Write-Output "PowerShell: $PowerShellPath ($version)"
    Write-Output "Project: $ProjectDir"
    Write-Output 'Tasks use InteractiveToken; the configured user must remain signed in (the session may be locked).'
    $reports | Select-Object TaskName, Healthy, State, Execute, WorkingDirectory, LastTaskResultHex, NextRunTime | Format-Table -AutoSize
  }
  if (-not $result.ok) { exit 3 }
  exit 0
}

foreach ($definition in $definitions) {
  if (-not (Test-Path -LiteralPath $definition.Template -PathType Leaf)) {
    throw "Scheduled task template does not exist: $($definition.Template)"
  }
  if (-not (Test-Path -LiteralPath $definition.Script -PathType Leaf)) {
    throw "Scheduled task script does not exist: $($definition.Script)"
  }

  [xml]$taskXml = Get-Content -LiteralPath $definition.Template -Raw
  $namespace = [System.Xml.XmlNamespaceManager]::new($taskXml.NameTable)
  $namespace.AddNamespace('task', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
  $commandNode = $taskXml.SelectSingleNode('/task:Task/task:Actions/task:Exec/task:Command', $namespace)
  $argumentsNode = $taskXml.SelectSingleNode('/task:Task/task:Actions/task:Exec/task:Arguments', $namespace)
  $workingDirectoryNode = $taskXml.SelectSingleNode('/task:Task/task:Actions/task:Exec/task:WorkingDirectory', $namespace)
  if (-not $commandNode -or -not $argumentsNode -or -not $workingDirectoryNode) {
    throw "Scheduled task template has an invalid Exec action: $($definition.Template)"
  }

  $commandNode.InnerText = $PowerShellPath
  $argumentsNode.InnerText = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($definition.Script)`" -ProjectDir `"$ProjectDir`""
  $workingDirectoryNode.InnerText = $ProjectDir

  if ($PSCmdlet.ShouldProcess($definition.TaskName, "register with PowerShell $version at $PowerShellPath")) {
    Register-ScheduledTask -TaskName $definition.TaskName -Xml $taskXml.OuterXml -Force | Out-Null
  }
}

if (-not $WhatIfPreference) {
  $reports = @($definitions | ForEach-Object { Get-TaskReport $_ })
  $configurationOk = @($reports | Where-Object { -not $_.configurationHealthy }).Count -eq 0
  $result = [pscustomobject]@{
    ok = $configurationOk
    projectDir = $ProjectDir
    powershellPath = $PowerShellPath
    powershellVersion = $version.ToString()
    prefersPowerShell7 = $true
    requiresLoggedInUser = $true
    tasks = $reports
  }
  if ($Json) {
    $result | ConvertTo-Json -Depth 8
  } else {
    $reports | Select-Object TaskName, ConfigurationHealthy, Healthy, State, Execute, WorkingDirectory, LastTaskResultHex, NextRunTime
  }
  if (-not $configurationOk) { exit 3 }
}
