[CmdletBinding()]
param(
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$defaultConfigPath = Join-Path $localAppData 'am-market-analytics\resources.json'

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = $env:AM_MARKET_ANALYTICS_CONFIG
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = $defaultConfigPath
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw '本地固定资源配置不存在。'
}

try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw '本地固定资源配置不是有效的JSON。'
}

function Get-ResourceUrl {
    param(
        [object]$Section,
        [string]$Name
    )

    if ($null -eq $Section) {
        throw "本地固定资源配置缺少$Name配置。"
    }

    $value = [string]$Section.url
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "本地固定资源配置缺少$Name地址。"
    }

    try {
        $uri = [System.Uri]$value
    } catch {
        throw "本地固定资源配置中的$Name地址无效。"
    }

    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https')) {
        throw "本地固定资源配置中的$Name地址无效。"
    }
}

Get-ResourceUrl -Section $config.data_workbook -Name '数据工作簿'
Get-ResourceUrl -Section $config.formal_document -Name '正式文档'

Write-Output 'LOCAL_RESOURCE_CONFIG: PASS'
