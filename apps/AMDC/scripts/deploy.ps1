# AMTools 一键部署脚本 (PowerShell 7 / Windows PowerShell 5.1)
# 用法:
#   git clone https://gitee.com/Hawkiethehawk/AMTools.git
#   cd AMTools; .\apps\AMDC\scripts\deploy.ps1
param(
    [string]$InstallDir = $PWD.Path
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://gitee.com/Hawkiethehawk/AMTools.git"

if ($PSVersionTable.PSVersion -lt [version]'5.1') {
    throw "This deployment script requires PowerShell 7 or Windows PowerShell 5.1."
}

function Remove-LegacyAMDCProfileBlocks {
    $documents = [Environment]::GetFolderPath('MyDocuments')
    $profilePaths = @(
        $PROFILE.CurrentUserCurrentHost
        $PROFILE.CurrentUserAllHosts
        (Join-Path $documents 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1')
        (Join-Path $documents 'WindowsPowerShell\profile.ps1')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

    $pattern = '(?ms)^\s*# >>> AMDC default project >>>.*?^\s*# <<< AMDC default project <<<\s*(?:\r?\n)?'
    foreach ($profilePath in $profilePaths) {
        if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { continue }
        $profileText = [IO.File]::ReadAllText($profilePath)
        $updated = [regex]::Replace($profileText, $pattern, '')
        if ($updated -ne $profileText) {
            [IO.File]::WriteAllText($profilePath, $updated, [Text.UTF8Encoding]::new($false))
            Write-Host "[✓] 已清理旧 AMDC Profile 包装函数: $profilePath" -ForegroundColor Green
        }
    }
}

function Set-AMDCEnvironment {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectDir
    )

    $resolvedProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
    [Environment]::SetEnvironmentVariable("AMDC_PROJECT_DIR", $resolvedProjectDir, "User")
    [Environment]::SetEnvironmentVariable("APPMAGIC_PROJECT_DIR", $null, "User")
    $env:AMDC_PROJECT_DIR = $resolvedProjectDir
    Remove-Item Env:APPMAGIC_PROJECT_DIR -ErrorAction SilentlyContinue
    Write-Host "[✓] 已设置默认项目目录: $resolvedProjectDir" -ForegroundColor Green
    Write-Host "[✓] 已删除旧 APPMAGIC_PROJECT_DIR 用户变量" -ForegroundColor Green
}

function Register-AMDASkillLink {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDir,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    $source = (Resolve-Path -LiteralPath $SourceDir).Path
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null

    if (Test-Path -LiteralPath $Destination) {
        $item = Get-Item -LiteralPath $Destination -Force
        if ($item.LinkType -eq 'Junction' -and [string]::Equals([string]$item.Target, $source, [StringComparison]::OrdinalIgnoreCase)) {
            Write-Host "[✓] AMDA Skill 已注册: $Destination" -ForegroundColor Green
            return
        }
        throw "AMDA Skill destination already exists and is not the expected Junction: $Destination"
    }

    New-Item -ItemType Junction -Path $Destination -Target $source | Out-Null
    Write-Host "[✓] 已注册 AMDA Skill: $Destination -> $source" -ForegroundColor Green
}

# 支持通过环境变量覆盖
if ($env:AMDC_INSTALL_DIR) {
    $InstallDir = $env:AMDC_INSTALL_DIR
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  AMTools 一键部署 (Windows / PowerShell $($PSVersionTable.PSVersion))" -ForegroundColor Cyan
Write-Host "  安装目录: $InstallDir" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. 克隆独立仓库 ──
$RepoRoot = $InstallDir
if (Test-Path "$InstallDir\apps\AMDC\am.js") {
    Write-Host "[✓] AMTools 独立仓库已存在，跳过克隆" -ForegroundColor Green
} else {
    if (Test-Path $InstallDir) {
        $entries = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
        if ($entries.Count -gt 0) {
            $RepoRoot = Join-Path $InstallDir "AMTools"
        }
    } else {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    }
    Write-Host "[✓] 克隆 AMTools 独立仓库..." -ForegroundColor Green
    git clone $RepoUrl $RepoRoot
}

$ProjectDir = Join-Path $RepoRoot "apps\AMDC"
if (-not (Test-Path "$ProjectDir\am.js")) {
    throw "AMDC 项目入口不存在: $ProjectDir"
}

$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path

# ── 2. Node 依赖 ──
Write-Host "[✓] 安装 Node 依赖..." -ForegroundColor Green
npm --prefix $RepoRoot install
npm --prefix $ProjectDir install
Write-Host "[✓] MiSans 本地字体已随项目就绪" -ForegroundColor Green

# ── 3. Python 依赖 ──
Write-Host "[✓] 安装 openpyxl..." -ForegroundColor Green
try {
    python -c "import openpyxl" 2>$null
    Write-Host "[✓] openpyxl 已安装" -ForegroundColor Green
} catch {
    pip install openpyxl
}

# ── 4. 全局 CLI ──
Write-Host "[✓] 注册全局 amtools 命令..." -ForegroundColor Green
Push-Location $RepoRoot
try { npm link } finally { Pop-Location }
Write-Host "[✓] 注册全局 amdc 命令..." -ForegroundColor Green
Push-Location $ProjectDir
try { npm link } finally { Pop-Location }

# ── 5. 环境变量与旧 Profile 清理 ──
Write-Host "[✓] 配置 AMDC 项目目录并清理旧包装函数..." -ForegroundColor Green
Remove-LegacyAMDCProfileBlocks
Set-AMDCEnvironment -ProjectDir $ProjectDir

# ── 6. AMDA Skill 注册 ──
$AmdaDir = Join-Path $RepoRoot 'skills\AMDA'
if (-not (Test-Path -LiteralPath (Join-Path $AmdaDir 'SKILL.md') -PathType Leaf)) {
    throw "AMDA Skill entry does not exist: $AmdaDir\SKILL.md"
}
Register-AMDASkillLink -SourceDir $AmdaDir -Destination (Join-Path $HOME '.claude\skills\AMDA')
Register-AMDASkillLink -SourceDir $AmdaDir -Destination (Join-Path $HOME '.codex\skills\AMDA')

# ── 7. 验证 ──
$amtoolsCommand = Get-Command amtools.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
$amdcCommand = Get-Command amdc.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
& $amtoolsCommand.Source version | Out-Host
if ($LASTEXITCODE -ne 0) { throw "AMTools CLI verification failed with exit code $LASTEXITCODE" }
& $amdcCommand.Source help | Out-Host
if ($LASTEXITCODE -ne 0) { throw "AMDC CLI verification failed with exit code $LASTEXITCODE" }
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "[✓] 部署完成！" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  AMTools仓库: $RepoRoot"
Write-Host "  AMDC目录 : $ProjectDir"
Write-Host "  CLI      : amtools / amdc（执行后不改变当前目录）"
Write-Host "  Dashboard: amdc dashboard  (Windows 8787 / WSL 8788)"
Write-Host ""
Write-Host "  下一步 — 登录账号（逐个执行）:" -ForegroundColor Yellow
Write-Host '    $env:AMDC_EMAIL="账号@邮箱.com"; amdc login'
Write-Host '    $env:AMDC_EMAIL="账号@邮箱.com"; $env:AMDC_USERDATA_DIR=".amdc-userdata-b"; amdc login'
Write-Host "    ... (6个 profile a-f)"
Write-Host ""
Write-Host "  或查看状态: amdc status" -ForegroundColor Yellow
