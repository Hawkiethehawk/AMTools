param(
  [string]$ProjectDir = ".",
  [string]$WeekAnchor = "",
  [string[]]$Categories = @(),
  [switch]$Fresh,
  [switch]$ListOnly,
  [switch]$MissingCountriesOnly,
  [switch]$ExportOnly,
  [switch]$SkipExcel,
  [switch]$SkipFeishuSync,
  [switch]$SkipNotifications
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillRoot = Split-Path -Parent $ScriptDir
$ProjectDir = (Resolve-Path $ProjectDir).Path

# 统一计算周锚点并传给 js/py：运行缓存放 Cache/<YYYYMMDD>/，唯一交付物放 output/AMDC-<YYYYMMDD>.xlsx。
if (-not $WeekAnchor) {
  $d = (Get-Date).Date
  [int]$dayOfWeek = $d.DayOfWeek
  $daysSinceMonday = (($dayOfWeek + 6) % 7)
  $WeekAnchor = $d.AddDays(-$daysSinceMonday - 7).ToString('yyyy-MM-dd')
}
if ($WeekAnchor -notmatch '^\d{4}-\d{2}-\d{2}$') {
  throw "WeekAnchor 必须使用 YYYY-MM-DD 格式，且只能选择周一: $WeekAnchor"
}
try {
  $parsedAnchor = [datetime]::ParseExact($WeekAnchor, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
} catch {
  throw "WeekAnchor 不是有效日期，且只能选择周一: $WeekAnchor"
}
if ($parsedAnchor.DayOfWeek -ne [System.DayOfWeek]::Monday) {
  throw "WeekAnchor 只能选择周一: $WeekAnchor"
}
$env:WEEK_ANCHOR = $WeekAnchor
$Mon = $WeekAnchor.Replace('-', '')
$CacheDir = Join-Path $ProjectDir ("Cache\{0}" -f $Mon)

function U([int[]]$codes) {
  -join ($codes | ForEach-Object { [char]$_ })
}

if ((-not $Categories -or $Categories.Count -eq 0) -and $env:AMDC_CATEGORIES) {
  try {
    # Windows PowerShell 5.1 会把 JSON 数组作为单个 Object[] 包装；先显式转换，
    # 否则再次 ConvertTo-Json 会得到 {"value":[...],"Count":N}，Node 无法识别。
    $configuredCategories = [string[]]($env:AMDC_CATEGORIES | ConvertFrom-Json)
    if ($configuredCategories.Count -gt 0) { $Categories = $configuredCategories }
  } catch {
    throw "AMDC_CATEGORIES 不是有效的品类数组"
  }
}

if (-not $Categories -or $Categories.Count -eq 0) {
  $Categories = @(
    (U 0x8D85,0x4F11,0x95F2),
    (U 0x4F11,0x95F2),
    (U 0x58C1,0x7EB8),
    "Launcher",
    (U 0x6740,0x6BD2,0x8F6F,0x4EF6,0x3001,0x6E05,0x7406),
    (U 0x6587,0x4EF6,0x6062,0x590D),
    ("PDF" + (U 0x9605,0x8BFB,0x5668))
  )
}

# 从 amdc-config.json 读取默认值（env vars 优先，配置文件作为 fallback）
$ConfigFile = Join-Path $ProjectDir "amdc-config.json"
if (Test-Path $ConfigFile) {
  try {
    $cfg = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $env:TOP_DEPTH -and $cfg.topDepth)           { $env:TOP_DEPTH = "$($cfg.topDepth)" }
    if (-not $env:AMDC_ACCOUNTS -and $cfg.accounts)    { $env:AMDC_ACCOUNTS = $cfg.accounts }
    if (-not $env:AMDC_MAX_WORKERS -and $cfg.maxWorkers) { $env:AMDC_MAX_WORKERS = "$($cfg.maxWorkers)" }
    if (-not $env:DC_GAP_MS -and $cfg.dcGapMs)             { $env:DC_GAP_MS = "$($cfg.dcGapMs)" }
    if (-not $env:DC_COOLDOWN_MS -and $cfg.dcCooldownMs)   { $env:DC_COOLDOWN_MS = "$($cfg.dcCooldownMs)" }
    if (-not $env:LEADERBOARD_WEEK_CONCURRENCY -and $cfg.leaderboardWeekConcurrency) { $env:LEADERBOARD_WEEK_CONCURRENCY = "$($cfg.leaderboardWeekConcurrency)" }
    if (-not $env:AUTH_CHECK_CONCURRENCY -and $cfg.authCheckConcurrency) { $env:AUTH_CHECK_CONCURRENCY = "$($cfg.authCheckConcurrency)" }
    if (-not $env:AUTH_PROBE_TIMEOUT_MS -and $cfg.authProbeTimeoutMs) { $env:AUTH_PROBE_TIMEOUT_MS = "$($cfg.authProbeTimeoutMs)" }
    if (-not $env:LIST_ONLY -and $cfg.PSObject.Properties['listOnly'] -and $cfg.listOnly) { $env:LIST_ONLY = "1" }
  } catch {
    Write-Host "  ⚠️  配置文件读取失败: $ConfigFile -- $($_.Exception.Message)"
  }
}

$env:AMDC_PROJECT_DIR = $ProjectDir
# ConvertTo-Json 的管道输入会把单元素数组展开成字符串，导致 Node 端
# 将 AMDC_CATEGORIES 误判为无效配置；显式使用 InputObject 保留数组。
$env:AMDC_CATEGORIES = (ConvertTo-Json -InputObject @($Categories) -Compress)
if ($Fresh) { $env:FORCE_REFRESH = "1" }
if ($ListOnly) { $env:LIST_ONLY = "1" }
if ($MissingCountriesOnly) { $env:MISSING_COUNTRY_ONLY = "1" }

function Test-IsWindowsHost {
  if ($PSVersionTable.PSEdition -eq "Desktop") { return $true }
  return [bool]$IsWindows
}

function Test-IsWslHost {
  if (Test-IsWindowsHost) { return $false }
  try {
    return ((Get-Content "/proc/version" -Raw -ErrorAction Stop) -match "(?i)microsoft|wsl")
  } catch {
    return $false
  }
}

function Get-DashboardPort {
  if ($env:AMDC_PORT) { return "$($env:AMDC_PORT)" }
  if (Test-IsWslHost) { return "8788" }
  return "8787"
}

function Ensure-DashboardServer {
  param(
    [string]$ScriptDir,
    [string]$ProjectDir
  )

  $port = Get-DashboardPort
  $dashboardUrl = "http://127.0.0.1:$port"
  $settings = $null

  try {
    $settings = Invoke-RestMethod -Uri "$dashboardUrl/api/settings" -TimeoutSec 2
    if ($settings.projectDir -eq $ProjectDir) {
      Write-Host "  看板已运行 $dashboardUrl (pid $($settings.pid))"
      return
    }
    Write-Host "  端口 $port 已被其他 AMDC 项目占用：$($settings.projectDir)"
  } catch {
    $settings = $null
  }

  if ($settings -and $settings.pid) {
    try {
      Stop-Process -Id $settings.pid -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 600
      Write-Host "  已停止旧看板进程 pid $($settings.pid)"
    } catch {
      throw "无法停止旧看板进程 pid $($settings.pid)"
    }
  }

  $savedProjectDir = $env:AMDC_PROJECT_DIR
  $savedNoOpen = $env:AMDC_NO_OPEN
  $savedPort = $env:AMDC_PORT
  try {
    $env:AMDC_PROJECT_DIR = $ProjectDir
    $env:AMDC_NO_OPEN = "1"
    $env:AMDC_PORT = $port
    $startArgs = @{
      FilePath = "node"
      ArgumentList = @((Join-Path $ScriptDir "progress-server.js"))
      PassThru = $true
    }
    if (Test-IsWindowsHost) { $startArgs.WindowStyle = "Hidden" }
    $proc = Start-Process @startArgs
    Start-Sleep -Milliseconds 800
    Write-Host "  进度看板已启动 $dashboardUrl (pid $($proc.Id))"
  } finally {
    if ($null -ne $savedProjectDir) { $env:AMDC_PROJECT_DIR = $savedProjectDir } else { Remove-Item Env:AMDC_PROJECT_DIR -ErrorAction SilentlyContinue }
    if ($null -ne $savedNoOpen) { $env:AMDC_NO_OPEN = $savedNoOpen } else { Remove-Item Env:AMDC_NO_OPEN -ErrorAction SilentlyContinue }
    if ($null -ne $savedPort) { $env:AMDC_PORT = $savedPort } else { Remove-Item Env:AMDC_PORT -ErrorAction SilentlyContinue }
  }
}

# 依赖检查：以 node 实际解析为准（npm 可能把包装到上层带 package.json 的目录）
Push-Location $ScriptDir
node -e "require.resolve('@playwright/test')" 2>$null
$hasPlaywright = ($LASTEXITCODE -eq 0)
Pop-Location
if (-not $hasPlaywright) {
  Write-Host "  ⚠️  缺少依赖，正在安装 @playwright/test ..."
  Push-Location $SkillRoot; npm install @playwright/test; npx playwright install chromium; Pop-Location
}

Write-Host "  📅 WeekAnchor: $WeekAnchor  ProjectDir: $ProjectDir"

function Send-RunNotification {
  param(
    [ValidateSet('success', 'failure', 'auth_expired', 'auth_checked', 'collection_started', 'week_complete', 'collection_complete', 'feishu_sync_started', 'feishu_sync_complete')]
    [string]$Event,
    [long]$DurationMs = 0
  )

  if ($SkipNotifications) { return }

  $notifyScript = Join-Path $ScriptDir "notify.js"
  if (-not (Test-Path $notifyScript)) { return }
  $notifyArgs = @($notifyScript, $CacheDir, '--event', $Event, '--config', $ConfigFile)
  $notifyArgs += @('--duration-ms', "$DurationMs")
  try {
    & node @notifyArgs
    if ($LASTEXITCODE -ne 0 -and $Event -eq 'success') {
      Write-Warning "ntfy 通知未确认发送成功（退出码 $LASTEXITCODE）"
    }
  } catch {
    Write-Warning "ntfy 通知发送失败：$($_.Exception.Message)"
  }
}

try {
  if (-not $ExportOnly) {
    # 启动当前项目的进度看板；若端口已被其他项目占用，则替换为当前项目服务。
    Ensure-DashboardServer -ScriptDir $ScriptDir -ProjectDir $ProjectDir

    # 看板启动任务前已统一校验账号；批量子任务跳过重复探针，避免并发探针互相限流。
    if ($env:AMDC_SKIP_AUTH_CHECK -ne "1") {
      $authStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
      $env:CHECK_AUTH = "1"
      $checkOut = node (Join-Path $ScriptDir "amdc-weekly.js") | Out-String
      Remove-Item Env:CHECK_AUTH -ErrorAction SilentlyContinue
      Write-Host $checkOut
      $failedAccounts = @([regex]::Matches($checkOut, 'FAIL (\S+)') | ForEach-Object { $_.Groups[1].Value })
      if ($failedAccounts.Count -gt 0) {
        $failedList = ($failedAccounts -join ', ')
        throw "AMDC login state invalid for: $failedList. Open dashboard settings and recapture those accounts before running collection."
      }
      $validAccounts = @([regex]::Matches($checkOut, '(?m)^OK \S+') | ForEach-Object { $_.Value })
      $authStopwatch.Stop()
      Send-RunNotification -Event auth_checked -DurationMs $authStopwatch.ElapsedMilliseconds
    }

    # 路径A：单次调用，node 一个进程跑全部品类（榜单用 A；国别 3 账号并行领品类）
    $collectionStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    Send-RunNotification -Event collection_started -DurationMs 0
    node (Join-Path $ScriptDir "amdc-weekly.js")
    if ($LASTEXITCODE -ne 0) { throw "AMDC scrape failed" }
    $collectionStopwatch.Stop()
    Send-RunNotification -Event week_complete -DurationMs $collectionStopwatch.ElapsedMilliseconds
    Send-RunNotification -Event collection_complete -DurationMs $collectionStopwatch.ElapsedMilliseconds
  }

  if (-not $SkipExcel) {
    python (Join-Path $ScriptDir "amdc_xlsx_merged.py")
    if ($LASTEXITCODE -ne 0) { throw "Merged Excel export failed" }
    $xlsx = Join-Path $ProjectDir ("output\AMDC-{0}.xlsx" -f $Mon)
    Write-Host "  ✅ 唯一输出: $xlsx"
    if (-not $SkipFeishuSync) {
      $feishuStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
      Send-RunNotification -Event feishu_sync_started -DurationMs 0
      python (Join-Path $ScriptDir "amdc_feishu_sync.py") --xlsx $xlsx --week $WeekAnchor
      if ($LASTEXITCODE -ne 0) { throw "Feishu sync failed" }
      $feishuStopwatch.Stop()
      Send-RunNotification -Event feishu_sync_complete -DurationMs $feishuStopwatch.ElapsedMilliseconds
    }
  }
}
catch {
  $message = $_.Exception.Message
  $event = if ($message -match 'login state invalid|token.*失效|auth') { 'auth_expired' } else { 'failure' }
  Send-RunNotification -Event $event
  throw
}
finally {
  Remove-Item Env:CHECK_AUTH -ErrorAction SilentlyContinue
  Remove-Item Env:AMDC_USERDATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:FORCE_REFRESH -ErrorAction SilentlyContinue
  Remove-Item Env:LIST_ONLY -ErrorAction SilentlyContinue
  Remove-Item Env:WEEK_ANCHOR -ErrorAction SilentlyContinue
  Remove-Item Env:AMDC_PROJECT_DIR -ErrorAction SilentlyContinue
}
