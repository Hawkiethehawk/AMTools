# AMDC 账号登录态检测 + 有效账号配置备份到 gitee 账户信息仓库
#
# 用法:
#   pwsh -ExecutionPolicy Bypass -File sync-account-profiles.ps1 -ProjectDir .
#   pwsh -ExecutionPolicy Bypass -File sync-account-profiles.ps1 -DryRun
#     DryRun: 仅检测登录态并构建暂存区，不发送 ntfy 通知、不推送 gitee。
#
param(
  [string]$ProjectDir = (Join-Path $PSScriptRoot '..'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path $ProjectDir).Path
$LogDir = Join-Path $ProjectDir 'logs'
$LogFile = Join-Path $LogDir 'account-sync.log'
$StagingDir = Join-Path $ProjectDir 'Cache\account-sync-staging'
$ConfigPath = Join-Path $ProjectDir 'amdc-config.json'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-AccountRepoUrl {
  $value = [string]$env:AMDC_ACCOUNT_REPOSITORY_URL
  if (-not $value -and (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    try {
      $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $value = [string]$config.integrations.accountRepositoryUrl
    } catch {
      throw 'AMDC config is not valid JSON.'
    }
  }
  $value = $value.Trim()
  if (-not $value) {
    throw 'Account repository URL is not configured. Set integrations.accountRepositoryUrl in amdc-config.json or AMDC_ACCOUNT_REPOSITORY_URL.'
  }
  try { $uri = [uri]$value } catch { throw 'Account repository URL is invalid.' }
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('https', 'ssh')) {
    throw 'Account repository URL must be an absolute HTTPS or SSH URL.'
  }
  return $value
}

function Write-SyncLog([string]$Message) {
  Add-Content -LiteralPath $LogFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
}

function Get-NtfyConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
  try {
    $cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return $cfg.notifications.default
  } catch {
    return $null
  }
}

function Send-Ntfy {
  param(
    [string]$Title,
    [string]$Body,
    [int]$Priority = 3,
    [string]$Tags = 'white_check_mark'
  )
  if ($DryRun) {
    Write-SyncLog "[DryRun] 跳过 ntfy 通知: $Title"
    return
  }
  $n = Get-NtfyConfig
  if (-not $n -or $n.type -ne 'ntfy') {
    Write-SyncLog 'ntfy 配置缺失或类型不是 ntfy，跳过通知'
    return
  }
  $baseUrl = ([string]$n.url).TrimEnd('/')
  $topic = [string]$n.topic
  if (-not $baseUrl -or -not $topic) {
    Write-SyncLog 'ntfy url/topic 为空，跳过通知'
    return
  }
  $bodyFile = Join-Path $LogDir 'account-sync-ntfy-body.txt'
  [System.IO.File]::WriteAllText($bodyFile, $Body, (New-Object System.Text.UTF8Encoding($false)))
  $args = @(
    '--silent', '--show-error', '--fail-with-body', '--output', 'NUL',
    '--header', 'Content-Type: text/plain; charset=utf-8',
    '--data-binary', "@$bodyFile"
  )
  if ($n.token) {
    $args += '--header'
    $args += "Authorization: Bearer $($n.token)"
  } elseif ($n.username -and $n.password) {
    $args += '--user'
    $args += "$($n.username):$($n.password)"
  }
  $url = "$baseUrl/$($topic)?title=$([uri]::EscapeDataString($Title))&priority=$Priority&tags=$Tags"
  $args += $url
  & curl.exe $args 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-SyncLog "ntfy 发送失败: $Title (curl exit $LASTEXITCODE)"
  } else {
    Write-SyncLog "ntfy 已发送: $Title"
  }
}

function Invoke-AuthCheck {
  $savedProjectDir = $env:AMDC_PROJECT_DIR
  $savedNoOpen = $env:AMDC_NO_OPEN
  $previousLocation = Get-Location
  try {
    $env:AMDC_PROJECT_DIR = $ProjectDir
    $env:AMDC_NO_OPEN = '1'
    Set-Location -LiteralPath $ProjectDir
    $output = & node 'am.js' 'check' 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{ ExitCode = $code; Output = ($output -join "`n") }
  } catch {
    return [pscustomobject]@{ ExitCode = -1; Output = $_.Exception.Message }
  } finally {
    Set-Location -LiteralPath $previousLocation.Path
    if ($null -ne $savedProjectDir) { $env:AMDC_PROJECT_DIR = $savedProjectDir }
    else { Remove-Item Env:AMDC_PROJECT_DIR -ErrorAction SilentlyContinue }
    if ($null -ne $savedNoOpen) { $env:AMDC_NO_OPEN = $savedNoOpen }
    else { Remove-Item Env:AMDC_NO_OPEN -ErrorAction SilentlyContinue }
  }
}

function Get-DiscoveredProfiles {
  Get-ChildItem -LiteralPath $ProjectDir -Force -Directory |
    Where-Object { $_.Name -match '^\.amdc-userdata(-.+)?$' } |
    Sort-Object Name |
    ForEach-Object { $_.Name }
}

function Sync-Staging {
  param([string[]]$OkDirs)
  $ExcludeDirs = @(
    'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
    'GPUPersistentCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache',
    'component_crx_cache', 'extensions_crx_cache', 'Crashpad', 'BrowserMetrics',
    'AutofillAiModelCache', 'Safe Browsing', 'segmentation_platform',
    'Service Worker', 'Sessions'
  )
  foreach ($dir in $OkDirs) {
    $src = Join-Path $ProjectDir $dir
    if (-not (Test-Path -LiteralPath $src)) {
      Write-SyncLog "跳过不存在的账号目录: $dir"
      continue
    }
    $dst = Join-Path $StagingDir $dir
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    $roboArgs = @($src, $dst, '/MIR', '/XD') + $ExcludeDirs + @('/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
    & robocopy.exe $roboArgs | Out-Null
    if ($LASTEXITCODE -ge 8) {
      Write-SyncLog "robocopy 失败(exit $LASTEXITCODE): $dir"
    } else {
      $fileCount = (Get-ChildItem -LiteralPath $dst -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count
      Write-SyncLog "已同步到暂存区: $dir ($fileCount 个文件)"
    }
  }
}

function Push-ToGitee {
  if ($DryRun) {
    Write-SyncLog '[DryRun] 跳过 git 提交与 gitee 推送'
    return
  }
  $AccountRepoUrl = Get-AccountRepoUrl
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $StagingDir '.git'))) {
      git -C $StagingDir init -b master 2>$null | Out-Null
      git -C $StagingDir remote add origin $AccountRepoUrl 2>$null | Out-Null
      Write-SyncLog '暂存区 git 仓库已初始化'
    } elseif (git -C $StagingDir remote 2>$null | Where-Object { $_ -eq 'origin' }) {
      git -C $StagingDir remote set-url origin $AccountRepoUrl 2>$null | Out-Null
    } else {
      git -C $StagingDir remote add origin $AccountRepoUrl 2>$null | Out-Null
    }
    git -C $StagingDir config core.autocrlf false 2>$null | Out-Null
    git -C $StagingDir fetch origin 2>$null | Out-Null
    $changed = git -C $StagingDir status --porcelain 2>$null
    if ($changed) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      git -C $StagingDir add -A 2>$null
      if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
      git -C $StagingDir commit -m "backup AMDC account profiles $stamp" 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
      Write-SyncLog "已提交: backup AMDC account profiles $stamp"
    } else {
      Write-SyncLog '账号数据无变化'
    }

    $localHead = git -C $StagingDir rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-SyncLog '暂无本地提交，跳过推送'
      return
    }
    $remoteHead = git -C $StagingDir rev-parse origin/master 2>$null
    if ($LASTEXITCODE -eq 0 -and $localHead -eq $remoteHead) {
      Write-SyncLog '远程已是最新，跳过推送'
      return
    }

    $isFastForward = git -C $StagingDir merge-base --is-ancestor 'HEAD' 'origin/master' 2>$null
    if ($LASTEXITCODE -eq 0) {
      git -C $StagingDir push origin master 2>$null
    } else {
      Write-SyncLog '远程包含本地没有的提交，使用安全强制推送覆盖'
      git -C $StagingDir push --force-with-lease origin master 2>$null
    }
    if ($LASTEXITCODE -ne 0) {
      Write-SyncLog "gitee 推送失败 (exit $LASTEXITCODE)"
      throw 'gitee push failed'
    }
    Write-SyncLog 'gitee 推送成功'
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

# ── 主流程 ──
try {
  Write-SyncLog '===== AMDC 账号登录态检测开始 ====='
  $discovered = @(Get-DiscoveredProfiles)
  Write-SyncLog "发现账号目录: $($discovered.Count) 个"

  Send-Ntfy -Title 'AMDC 账号备份 · 开始检测登录态' -Body "开始检测 AMDC 账号登录态，共 $($discovered.Count) 个账号。" -Priority 3 -Tags 'chart_with_upwards_trend'

  $result = Invoke-AuthCheck
  if ($result.ExitCode -eq -1) {
    Write-SyncLog '登录态检测执行失败:'
    foreach ($errLine in ($result.Output -split "`r?`n")) { Write-SyncLog "  $errLine" }
    Send-Ntfy -Title 'AMDC 账号备份 · 登录态检测结果' -Body "检测执行失败，本次未同步。`n$($result.Output)" -Priority 4 -Tags 'warning'
    throw 'auth check failed to run'
  }

  $okDirs = @()
  $failDirs = @()
  $unknownDirs = @()
  foreach ($line in ($result.Output -split "`r?`n")) {
    if ($line -match '^OK\s+(\.amdc-userdata(-.+)?)$') { $okDirs += $Matches[1] }
    elseif ($line -match '^FAIL\s+(\.amdc-userdata(-.+)?)$') { $failDirs += $Matches[1] }
    elseif ($line -match '^UNKNOWN\s+(\.amdc-userdata(-.+)?)$') { $unknownDirs += $Matches[1] }
  }

  Write-SyncLog "登录态结果: 通过 $($okDirs.Count)，失败 $($failDirs.Count)，未知 $($unknownDirs.Count)"
  if ($failDirs.Count) { Write-SyncLog ("失败账号: " + ($failDirs -join ', ')) }
  if ($unknownDirs.Count) { Write-SyncLog ("未知账号: " + ($unknownDirs -join ', ')) }

  $resultLines = @("共 $($discovered.Count) 个账号：通过 $($okDirs.Count)，失败 $($failDirs.Count)，未知 $($unknownDirs.Count)。")
  if ($failDirs.Count) { $resultLines += ("失败： " + ($failDirs -join '、')) }
  if ($unknownDirs.Count) { $resultLines += ("未知： " + ($unknownDirs -join '、')) }
  if (-not $failDirs.Count -and -not $unknownDirs.Count) { $resultLines += '全部账号登录态有效，将同步备份。' }
  else { $resultLines += '未全部通过，仅备份通过账号。' }
  $priority = if ($failDirs.Count -or $unknownDirs.Count) { 4 } else { 3 }
  $tags = if ($failDirs.Count -or $unknownDirs.Count) { 'warning' } else { 'white_check_mark' }
  Send-Ntfy -Title 'AMDC 账号备份 · 登录态检测结果' -Body ($resultLines -join "`n") -Priority $priority -Tags $tags

  if ($okDirs.Count -eq 0) {
    Write-SyncLog '没有登录态通过的账号，跳过同步与推送'
    return
  }

  $syncStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null
  Sync-Staging -OkDirs $okDirs
  Push-ToGitee
  $syncDurationSeconds = [Math]::Max(1, [int][Math]::Round($syncStopwatch.Elapsed.TotalSeconds))
  Send-Ntfy -Title 'AMDC 账号备份 · 同步成功' -Body "账号配置同步成功，共 $($okDirs.Count) 个账号已完成 Gitee 备份。`n阶段耗时：${syncDurationSeconds}s" -Priority 3 -Tags 'white_check_mark'
  Write-SyncLog '===== AMDC 账号同步流程结束 ====='
} catch {
  Write-SyncLog "账号同步流程异常: $($_.Exception.Message)"
  throw
}
