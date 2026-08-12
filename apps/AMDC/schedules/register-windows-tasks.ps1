[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ProjectDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path,
  [string]$PwshPath = (Join-Path $PSHOME 'pwsh.exe'),
  [switch]$CheckOnly,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path

if (-not (Test-Path -LiteralPath $PwshPath -PathType Leaf)) {
  throw "PowerShell 7 executable does not exist: $PwshPath"
}

$versionText = & $PwshPath -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'
if ($LASTEXITCODE -ne 0 -or -not $versionText) {
  throw "PowerShell 7 executable could not be started: $PwshPath"
}
$version = [version]([string]$versionText).Trim()
if ($version.Major -lt 7) {
  throw "Scheduled tasks require PowerShell 7, but $PwshPath reported $version"
}

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
      pwshPath = [string]::Equals([string]$action.Execute, $PwshPath, [System.StringComparison]::OrdinalIgnoreCase)
      arguments = [string]::Equals([string]$action.Arguments, $expectedArguments, [System.StringComparison]::Ordinal)
      workingDirectory = [string]::Equals([string]$action.WorkingDirectory, $ProjectDir, [System.StringComparison]::OrdinalIgnoreCase)
      interactiveToken = [string]$task.Principal.LogonType -eq 'Interactive'
      lastRun = (-not $hasRun) -or $lastResult -eq 0
    }
    $configurationHealthy = @(
      $checks.exists,
      $checks.enabled,
      $checks.pwshPath,
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
    pwshPath = $PwshPath
    pwshVersion = $version.ToString()
    interactiveUser = $interactiveUser
    requiresLoggedInUser = $true
    tasks = $reports
  }
  if ($Json) { $result | ConvertTo-Json -Depth 8 }
  else {
    Write-Output ("AMDC schedule doctor: {0}" -f $(if ($result.ok) { 'PASS' } else { 'FAIL' }))
    Write-Output "PowerShell: $PwshPath ($version)"
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

  $commandNode.InnerText = $PwshPath
  $argumentsNode.InnerText = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($definition.Script)`" -ProjectDir `"$ProjectDir`""
  $workingDirectoryNode.InnerText = $ProjectDir

  if ($PSCmdlet.ShouldProcess($definition.TaskName, "register with PowerShell $version at $PwshPath")) {
    Register-ScheduledTask -TaskName $definition.TaskName -Xml $taskXml.OuterXml -Force | Out-Null
  }
}

if (-not $WhatIfPreference) {
  $reports = @($definitions | ForEach-Object { Get-TaskReport $_ })
  $configurationOk = @($reports | Where-Object { -not $_.configurationHealthy }).Count -eq 0
  $result = [pscustomobject]@{
    ok = $configurationOk
    projectDir = $ProjectDir
    pwshPath = $PwshPath
    pwshVersion = $version.ToString()
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
