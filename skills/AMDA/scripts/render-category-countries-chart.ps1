[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DataPath,
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
$culture = [System.Globalization.CultureInfo]::InvariantCulture

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $projectDir = $env:AMDA_PROJECT_DIR
    if ([string]::IsNullOrWhiteSpace($projectDir)) {
        $projectDir = Split-Path -Parent $PSScriptRoot
    }
        $OutputPath = Join-Path $projectDir 'output\charts\04-countries.svg'
}

$data = Get-Content -Raw -LiteralPath $DataPath -Encoding UTF8 | ConvertFrom-Json
$rows = @($data.categoryCountries.rows)
if ($rows.Count -ne 7) { throw "categoryCountries.rows must contain 7 rows, got $($rows.Count)" }

$palette = @{
    IN = '#2f67e8'
    BR = '#f05a00'
    ID = '#12b76a'
    BD = '#7a5af8'
    PH = '#f79009'
    MX = '#16b8c4'
    IT = '#f04438'
    NG = '#98a2b3'
    EG = '#ee46bc'
    RU = '#0ba5ec'
}

function New-EscapedText {
    param([string]$Text)
    return [System.Security.SecurityElement]::Escape($Text)
}

function New-TextNode {
    param(
        [double]$X,
        [double]$Y,
        [string]$Text,
        [string]$Fill,
        [string]$Anchor = 'middle',
        [string]$Weight = 'normal',
        [double]$Size = 24
    )

    $dominant = if ($Anchor -eq 'middle') { 'middle' } else { 'alphabetic' }
    $textAnchor = if ($Anchor -eq 'end') { 'end' } elseif ($Anchor -eq 'start') { 'start' } else { 'middle' }
    if ([string]::IsNullOrWhiteSpace($Fill)) { $Fill = '#344054' }
    return '<text font-size="' + $Size.ToString($culture) + '" font-family="Noto Sans SC" font-weight="' + $Weight + '" fill="' + $Fill + '" text-anchor="' + $textAnchor + '" dominant-baseline="' + $dominant + '" x="0" y="0"><tspan x="' + $X.ToString($culture) + '" y="' + $Y.ToString($culture) + '" text-anchor="' + $textAnchor + '">' + (New-EscapedText $Text) + '</tspan></text>'
}

function New-LegendItem {
    param(
        [double]$X,
        [double]$Y,
        [string]$Code,
        [string]$Color
    )

    $marker = '<rect x="' + $X.ToString($culture) + '" y="' + ($Y - 8.8).ToString($culture) + '" width="17.6" height="17.6" fill="' + $Color + '" stroke="none" stroke-width="0" rx="3" ry="3"/>'
    $label = New-TextNode ($X + 28) ($Y + 0.5) $Code $null 'start' 'bold'
    return '<g>' + $marker + $label + '</g>'
}

# Collect unique countries in fixed first-appearance order.
$legendCodes = [System.Collections.Generic.List[string]]::new()
foreach ($row in $rows) {
    foreach ($country in @($row.countries)) {
        $code = [string]$country.country
        if (-not $legendCodes.Contains($code)) { [void]$legendCodes.Add($code) }
    }
}

$barStartX = 230.0
$barWidthAt100 = 1200.0
$rowPitch = 66.0
$rowStartY = 336.0
$barHeight = 44.0
$nameCenterX = 110.0
$legendCenterX = 745.0
$otherColor = '#e4e7ec'

$sb = [System.Text.StringBuilder]::new()
[void]$sb.Append('<svg xmlns="http://www.w3.org/2000/svg" width="1640" height="1020" viewBox="-20 -20 1640 1020">')
[void]$sb.Append('<g id="o1:1" transform="translate(0, 0)"><rect x="0" y="0" width="1600" height="980" fill="#ffffff" stroke="none" stroke-width="0" rx="0" ry="0"/></g>')
[void]$sb.Append('<g id="n1:1" transform="translate(50, 36)">')

# Header.
[void]$sb.Append('<g id="a1:1" transform="translate(0, 0)"><text font-size="56" font-family="Noto Sans SC" font-weight="bold" fill="#182230" text-anchor="start" dominant-baseline="alphabetic" x="0"><tspan x="0" y="46.589"><tspan x="0" text-anchor="start">分品类IAA重点国家</tspan></tspan></text></g>')
[void]$sb.Append('<g id="a1:2" transform="translate(0, 112.589)"><text font-size="24" font-family="Noto Sans SC" font-weight="normal" fill="#667085" text-anchor="start" dominant-baseline="middle" x="0" y="0"><tspan x="0" y="0"><tspan x="0" text-anchor="start" y="0">T2/T3范围内Top5重点国家份额·浅灰为其他/未纳入重点范围·柱长按0–100%绝对比例</tspan></tspan></text></g>')
[void]$sb.Append('<g id="c1:1" transform="translate(0, 178.589)"><path fill="none" stroke="#e5e7eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M 0 0 L 1491 0"/></g>')

# Legend (centered).
$itemWidths = @()
foreach ($code in $legendCodes) {
    $w = 46.0 + ([double]$code.Length * 8.0)
    $itemWidths += $w
}
$totalLegendWidth = ($itemWidths | Measure-Object -Sum).Sum
$legendLeft = $legendCenterX - ($totalLegendWidth / 2)
$legendY = 227.589
$cursor = $legendLeft
for ($i = 0; $i -lt $legendCodes.Count; $i++) {
    $code = $legendCodes[$i]
    $color = $palette[$code]
    if ($null -eq $color) { $color = '#94a3b8' }
    [void]$sb.Append((New-LegendItem $cursor $legendY $code $color))
    $cursor += $itemWidths[$i]
}

# Row boundaries and stacked bars.
for ($i = 0; $i -lt 7; $i++) {
    $centerY = $rowStartY + ($i * $rowPitch)
    $topY = $centerY - ($rowPitch / 2) + 3
    [void]$sb.Append('<g id="row-boundary-' + $i + '" transform="translate(0, ' + $topY.ToString($culture) + ')"><path fill="none" stroke="#e5e7eb" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" d="M 0 0 L 1491 0"/></g>')
}

$colorMap = @{}
for ($i = 0; $i -lt $rows.Count; $i++) {
    $row = $rows[$i]
    $centerY = $rowStartY + ($i * $rowPitch)
    $name = [string]$row.name
    [void]$sb.Append((New-TextNode $nameCenterX $centerY $name '#182230' 'middle' 'bold'))

    $countries = @($row.countries)
    $countryWidths = @()
    $countryWidthSum = 0.0
    foreach ($country in $countries) {
        $share = [double]$country.share
        if ($share -lt 0 -or $share -gt 100) { throw "$($row.name) country share is outside 0-100: $share" }
        $width = [math]::Round($barWidthAt100 * $share / 100.0, 1)
        $countryWidths += $width
        $countryWidthSum += $width
    }
    $x = $barStartX
    for ($countryIndex = 0; $countryIndex -lt $countries.Count; $countryIndex++) {
        $country = $countries[$countryIndex]
        $code = [string]$country.country
        $share = [double]$country.share
        $width = [double]$countryWidths[$countryIndex]
        $color = $palette[$code]
        if ($null -eq $color) { $color = '#94a3b8' }
        $colorMap[$code] = $color
        [void]$sb.Append('<rect x="' + $x.ToString($culture) + '" y="' + ($centerY - ($barHeight / 2)).ToString($culture) + '" width="' + $width.ToString($culture) + '" height="' + $barHeight.ToString($culture) + '" fill="' + $color + '" stroke="none" stroke-width="0" rx="' + ($barHeight / 2).ToString($culture) + '" ry="' + ($barHeight / 2).ToString($culture) + '"/>')

        $label = $null
        if ($width -ge 100) {
            $label = $code + ' ' + $share.ToString('0.0', $culture) + '%'
        }
        elseif ($width -ge 46) {
            $label = $code
        }
        if ($null -ne $label) {
            [void]$sb.Append((New-TextNode ($x + ($width / 2)) $centerY $label '#ffffff' 'middle' 'normal'))
        }
        $x += $width
    }

    $otherWidth = [math]::Round($barWidthAt100 - $countryWidthSum, 1)
    if ($otherWidth -lt 0) { throw "$($row.name) displayed country bars exceed 100%: $countryWidthSum" }
    if ($otherWidth -gt 0) {
        [void]$sb.Append('<rect x="' + $x.ToString($culture) + '" y="' + ($centerY - ($barHeight / 2)).ToString($culture) + '" width="' + $otherWidth.ToString($culture) + '" height="' + $barHeight.ToString($culture) + '" fill="' + $otherColor + '" stroke="none" stroke-width="0" rx="' + ($barHeight / 2).ToString($culture) + '" ry="' + ($barHeight / 2).ToString($culture) + '"/>')
        if ($otherWidth -ge 100) {
            $otherShare = [math]::Round($otherWidth / $barWidthAt100 * 100.0, 1)
            [void]$sb.Append((New-TextNode ($x + ($otherWidth / 2)) $centerY ("其他" + $otherShare.ToString('0.0', $culture) + '%') '#475467' 'middle' 'normal'))
        }
    }
}

# Note.
[void]$sb.Append('<g id="note-divider" transform="translate(0, 853.9652)"><path fill="none" stroke="#d9e1ea" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" d="M 0 0 L 1491 0"/></g>')
[void]$sb.Append((New-TextNode 0 872 ([string]$data.categoryCountries.note) '#475467' 'start' 'normal'))

[void]$sb.Append('</g></svg>')

$parent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[System.IO.File]::WriteAllText($OutputPath, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Output "CATEGORY_COUNTRIES_CHART: $OutputPath"
