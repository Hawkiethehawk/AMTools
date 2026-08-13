param(
    [Parameter(Mandatory = $true)]
    [string]$InputDir,

    [Parameter(Mandatory = $true)]
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'

$charts = @{
    '01-global.svg' = @{
        Title = '全球主分组结构'
        SectionTitles = @('下载侧', '收入侧')
        NormalizePercentWeight = $true
    }
    '02-trend.svg' = @{
        Title = '全部周期重点分组变化'
        SectionTitles = @()
        NormalizePercentWeight = $false
    }
    '03-category.svg' = @{
        Title = '各品类主要分组方向'
        SectionTitles = @('品类', '收入覆盖率')
        NormalizePercentWeight = $false
    }
    '04-regions.svg' = @{
        Title = '补充地区组下载与收入偏好'
        SectionTitles = @()
        NormalizePercentWeight = $true
    }
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

foreach ($fileName in $charts.Keys) {
    $sourcePath = Join-Path $InputDir $fileName
    $targetPath = Join-Path $OutputDir $fileName
    $rule = $charts[$fileName]
    $svg = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8

    $svg = [regex]::Replace(
        $svg,
        '<text\b[^>]*>.*?</text>',
        {
            param($match)

            $node = $match.Value
            $plainText = [regex]::Replace($node, '<[^>]+>', '')
            $fontSize = 24

            if ($plainText -eq $rule.Title) {
                $fontSize = 56
            }
            elseif ($rule.SectionTitles -contains $plainText) {
                $fontSize = 36
            }

            $node = [regex]::Replace(
                $node,
                'font-size="[^"]+"',
                "font-size=`"$fontSize`"",
                1
            )

            if (
                $rule.NormalizePercentWeight -and
                $plainText -match '^(?:(?:US|T1|T2|T3) )?\d+(?:\.\d+)?%$'
            ) {
                $node = $node.Replace('font-weight="bold"', 'font-weight="normal"')
            }

            return $node
        },
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )

    [System.IO.File]::WriteAllText($targetPath, $svg, (New-Object System.Text.UTF8Encoding($false)))
}
