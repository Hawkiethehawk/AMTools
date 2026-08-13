param(
    [Parameter(Mandatory = $true)]
    [string]$InputDir,

    [Parameter(Mandatory = $true)]
    [string]$OutputDir,

    [string[]]$ChartFile = @()
)

$ErrorActionPreference = 'Stop'
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$contractPath = Join-Path $PSScriptRoot '..\references\chart-layout-contract.json'
$contract = Get-Content -LiteralPath $contractPath -Raw -Encoding UTF8 | ConvertFrom-Json
$fixedHeaderLeft = 50
$fixedContentTop = 36
$fixedContentBottom = 932
$fixedHeaderTitleBaseline = 82.589
$fixedHeaderStep = 66
$fixedNoteDividerGap = 18.0348

function Get-ElementChildren {
    param([System.Xml.XmlNode]$Node)

    return @($Node.ChildNodes | Where-Object { $_.NodeType -eq 'Element' })
}

function Get-Translate {
    param([System.Xml.XmlElement]$Node)

    $value = $Node.GetAttribute('transform')
    if ($value -notmatch '^translate\(\s*([-+0-9.eE]+)[,\s]+([-+0-9.eE]+)\s*\)$') {
        throw "Unsupported transform '$value' on node $($Node.GetAttribute('id'))"
    }

    return @(
        [double]::Parse($Matches[1], $culture),
        [double]::Parse($Matches[2], $culture)
    )
}

function Set-Translate {
    param(
        [System.Xml.XmlElement]$Node,
        [double]$X,
        [double]$Y
    )

    $value = [string]::Format(
        $culture,
        'translate({0:0.####}, {1:0.####})',
        $X,
        $Y
    )
    $Node.SetAttribute('transform', $value)
}

function Move-Node {
    param(
        [System.Xml.XmlElement]$Node,
        [double]$DeltaX,
        [double]$DeltaY
    )

    $position = Get-Translate $Node
    Set-Translate $Node ($position[0] + $DeltaX) ($position[1] + $DeltaY)
}

function Set-TextHorizontalAlignment {
    param(
        [System.Xml.XmlElement]$Node,
        [ValidateSet('start', 'middle', 'end')]
        [string]$Anchor
    )

    $text = $Node.SelectSingleNode(".//*[local-name()='text']")
    if ($null -eq $text) {
        throw "Text node not found in $($Node.GetAttribute('id'))"
    }

    $text.SetAttribute('x', '0')
    $text.SetAttribute('text-anchor', $Anchor)
    foreach ($tspan in $text.SelectNodes(".//*[local-name()='tspan']")) {
        $tspan.SetAttribute('x', '0')
        $tspan.SetAttribute('text-anchor', $Anchor)
    }
}

function Set-TextCenter {
    param(
        [System.Xml.XmlElement]$Node,
        [double]$CenterX,
        [double]$CenterY
    )

    Set-Translate $Node $CenterX $CenterY
    Set-TextHorizontalAlignment $Node 'middle'

    $text = $Node.SelectSingleNode(".//*[local-name()='text']")
    $text.SetAttribute('y', '0')
    $text.SetAttribute('dominant-baseline', 'middle')
    foreach ($tspan in $text.SelectNodes(".//*[local-name()='tspan']")) {
        $tspan.SetAttribute('y', '0')
    }
}

function Set-TextVerticalCenter {
    param(
        [System.Xml.XmlElement]$Node,
        [double]$CenterY
    )

    $position = Get-Translate $Node
    Set-Translate $Node $position[0] $CenterY
    $text = $Node.SelectSingleNode(".//*[local-name()='text']")
    if ($null -eq $text) {
        throw "Text node not found in $($Node.GetAttribute('id'))"
    }
    $text.SetAttribute('y', '0')
    $text.SetAttribute('dominant-baseline', 'middle')
    foreach ($tspan in $text.SelectNodes(".//*[local-name()='tspan']")) {
        $tspan.SetAttribute('y', '0')
    }
}

function Get-TextBaseline {
    param([System.Xml.XmlElement]$Node)

    $text = $Node.SelectSingleNode(".//*[local-name()='text']")
    if ($null -eq $text) {
        throw "Text node not found in $($Node.GetAttribute('id'))"
    }

    $span = $text.SelectSingleNode(".//*[local-name()='tspan'][@y]")
    $value = if ($null -ne $span) { $span.GetAttribute('y') } else { $text.GetAttribute('y') }
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Text baseline not found in $($Node.GetAttribute('id'))"
    }

    return [double]::Parse($value, $culture)
}

function Set-FixedHeaderRhythm {
    param([System.Xml.XmlElement]$Main)

    $children = Get-ElementChildren $Main
    $title = $children[0]
    $subtitle = $children[1]
    $topRule = $children[2]
    $mainPosition = Get-Translate $Main
    $titlePosition = Get-Translate $title
    $rulePosition = Get-Translate $topRule
    $subtitlePosition = Get-Translate $subtitle
    $titleBaseline = Get-TextBaseline $title
    $titleY = $fixedHeaderTitleBaseline - $mainPosition[1] - $titleBaseline
    $subtitleCenterY = $fixedHeaderTitleBaseline + $fixedHeaderStep - $mainPosition[1]
    $topRuleY = $fixedHeaderTitleBaseline + (2 * $fixedHeaderStep) - $mainPosition[1]
    $headerLeft = $fixedHeaderLeft - $mainPosition[0]

    # Use one arithmetic progression for the title lower edge, subtitle center,
    # and first upper divider across all four charts. The title baseline is an
    # absolute canvas anchor so title-specific glyph metrics cannot shift the
    # following two elements.
    Set-Translate $title $headerLeft $titleY
    Set-Translate $subtitle $headerLeft $subtitleCenterY
    Set-Translate $topRule $headerLeft $topRuleY
    $text = $subtitle.SelectSingleNode(".//*[local-name()='text']")
    $text.SetAttribute('y', '0')
    $text.SetAttribute('dominant-baseline', 'middle')
    foreach ($tspan in $text.SelectNodes(".//*[local-name()='tspan']")) {
        $tspan.SetAttribute('y', '0')
    }
}

function Set-FixedCanvas {
    param([System.Xml.XmlElement]$Root)

    $Root.SetAttribute('width', '1640')
    $Root.SetAttribute('height', '1020')
    $Root.SetAttribute('viewBox', '-20 -20 1640 1020')

    $background = $Root.SelectSingleNode(
        "./*[local-name()='g'][1]/*[local-name()='rect']"
    )
    if ($null -eq $background) {
        throw 'Canvas background rectangle not found'
    }

    $background.SetAttribute('width', '1600')
    $background.SetAttribute('height', '980')
}

function Apply-VerticalRhythm {
    param([System.Xml.XmlElement]$Main)

    $children = Get-ElementChildren $Main
    Move-Node $children[1] 0 20
    for ($index = 2; $index -lt $children.Count; $index++) {
        Move-Node $children[$index] 0 60
    }
}

function Set-FixedContentFrame {
    param([System.Xml.XmlElement]$Main)

    $position = Get-Translate $Main
    Set-Translate $Main $position[0] $fixedContentTop
}

function Set-FixedNoteBottom {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Note
    )

    $mainPosition = Get-Translate $Main
    $notePosition = Get-Translate $Note
    $fontSize = [double]::Parse(
        $Note.SelectSingleNode(".//*[local-name()='text']").GetAttribute('font-size'),
        $culture
    )
    $noteTopY = $fixedContentBottom - $mainPosition[1] - $fontSize
    Set-Translate $Note $notePosition[0] $noteTopY
}

function Update-GlobalChart {
    param([System.Xml.XmlElement]$Main)

    $children = Get-ElementChildren $Main
    foreach ($node in @($children)) {
        if ($node.InnerText.Trim() -eq '100%堆叠') {
            [void]$Main.RemoveChild($node)
        }
    }

    $segments = @{}
    foreach ($node in (Get-ElementChildren $Main)) {
        $rect = $node.SelectSingleNode("./*[local-name()='rect']")
        if ($null -eq $rect -or $rect.GetAttribute('width') -ne '220') {
            continue
        }

        $code = switch ($rect.GetAttribute('fill').ToLowerInvariant()) {
            '#5b5ce2' { 'US' }
            '#20a7a0' { 'T1' }
            '#63bce3' { 'T2' }
            '#3867b9' { 'T3' }
            default { $null }
        }
        if ($null -eq $code) {
            continue
        }

        $position = Get-Translate $node
        $height = [double]::Parse($rect.GetAttribute('height'), $culture)
        $side = if ($position[0] -lt 800) { 'download' } else { 'income' }
        $segments["$side|$code"] = @{
            CenterX = $position[0] + 110
            CenterY = $position[1] + ($height / 2)
        }
    }

    foreach ($node in (Get-ElementChildren $Main)) {
        $label = $node.InnerText.Trim()
        if ($label -notmatch '^(US|T1|T2|T3) \d+(?:\.\d+)?%$') {
            continue
        }

        $position = Get-Translate $node
        $side = if ($position[0] -lt 800) { 'download' } else { 'income' }
        $segment = $segments["$side|$($Matches[1])"]
        if ($null -eq $segment) {
            throw "Segment geometry not found for $side $($Matches[1])"
        }

        Set-TextCenter $node $segment.CenterX $segment.CenterY
        $text = $node.SelectSingleNode(".//*[local-name()='text']")
        $text.SetAttribute('font-weight', 'normal')
    }

    foreach ($side in @(
        @{ Label = '下载侧'; CenterX = 462 },
        @{ Label = '收入侧'; CenterX = 1078 }
    )) {
        foreach ($node in (Get-ElementChildren $Main)) {
            if ($node.InnerText.Trim() -ne $side.Label) {
                continue
            }

            $position = Get-Translate $node
            Set-TextCenter $node $side.CenterX ($position[1] + 21.177)
        }
    }

    foreach ($side in @(
        @{ Top = '下载侧'; Bottom = '下载侧'; ColumnX = 352 },
        @{ Top = '收入侧'; Bottom = '收入侧'; ColumnX = 968 }
    )) {
        $labels = @(
            (Get-ElementChildren $Main) |
                Where-Object { $_.InnerText.Trim() -eq $side.Top } |
                Sort-Object { (Get-Translate $_)[1] }
        )
        if ($labels.Count -ne 2) {
            throw "Expected upper and lower labels for $($side.Top)"
        }

        $topLabel = $labels[0]
        $bottomLabel = $labels[1]
        $columnRects = @(
            (Get-ElementChildren $Main) |
                Where-Object {
                    $rect = $_.SelectSingleNode("./*[local-name()='rect']")
                    $null -ne $rect -and (Get-Translate $_)[0] -eq $side.ColumnX
                }
        )
        $topColumnY = ($columnRects | ForEach-Object { (Get-Translate $_)[1] } | Measure-Object -Minimum).Minimum
        $bottomColumnY = ($columnRects | ForEach-Object {
            $position = Get-Translate $_
            $rect = $_.SelectSingleNode("./*[local-name()='rect']")
            $position[1] + [double]::Parse($rect.GetAttribute('height'), $culture)
        } | Measure-Object -Maximum).Maximum
        $topPosition = Get-Translate $topLabel
        $bottomPosition = Get-Translate $bottomLabel
        $fontSize = [double]::Parse(
            $topLabel.SelectSingleNode(".//*[local-name()='text']").GetAttribute('font-size'),
            $culture
        )
        $mainPosition = Get-Translate $Main
        Set-TextCenter $bottomLabel $bottomPosition[0] (
            $fixedContentBottom - $mainPosition[1] - ($fontSize / 2)
        )
        $bottomPosition = Get-Translate $bottomLabel
        # Both labels use dominant-baseline="middle" after Set-TextCenter.
        # Compare their visible text edges, rather than their center points.
        $topGap = $topColumnY - ($topPosition[1] + ($fontSize / 2))
        $bottomGap = ($bottomPosition[1] - ($fontSize / 2)) - $bottomColumnY
        Set-Translate $topLabel $topPosition[0] ($topPosition[1] + ($topGap - $bottomGap))
    }
}

function Update-TrendChart {
    param([System.Xml.XmlElement]$Main)

    $children = Get-ElementChildren $Main

    # The plot spans 1296px. Align the plot to the fixed left edge, but do not
    # apply the source-to-normalized offset again when a normalized SVG is
    # being rechecked or repaired.
    $plotLines = @(
        $children |
            Where-Object {
                $path = $_.SelectSingleNode("./*[local-name()='path']")
                $null -ne $path -and $path.GetAttribute('d') -eq 'M 0 0 L 1296 0'
            }
    )
    if ($plotLines.Count -eq 0) {
        throw 'Trend plot lines not found'
    }
    $plotLeft = (Get-Translate $plotLines[0])[0]
    $plotDeltaX = 117.8232 - $plotLeft
    if ([math]::Abs($plotDeltaX) -gt 0.0001) {
        for ($index = 12; $index -le 60; $index++) {
            Move-Node $children[$index] $plotDeltaX 0
        }
    }

    # Keep the three current endpoint labels and recenter them below the plot.

    $updatedChildren = Get-ElementChildren $Main
    $note = $updatedChildren |
        Where-Object { $_.InnerText.Trim().StartsWith('口径：') } |
        Select-Object -First 1
    if ($null -eq $note) {
        throw 'Trend note not found'
    }

    $noteLeaf = $note.SelectSingleNode(".//*[local-name()='tspan'][not(*)]")
    if ($null -eq $noteLeaf) {
        throw 'Trend note text node not found'
    }
    $noteLeaf.InnerText = '口径：收入数据覆盖率表示有收入国Top5信息的应用×周记录比例；覆盖率偏低时，收入侧仅作方向性观察。'

    $notePosition = Get-Translate $note
    $noteDivider = $updatedChildren |
        Where-Object {
            $path = $_.SelectSingleNode("./*[local-name()='path']")
            $position = Get-Translate $_
            $null -ne $path -and
            $position[1] -lt $notePosition[1] -and
            $path.GetAttribute('d') -eq 'M 0 0 L 1468.8 0'
        } |
        Sort-Object { (Get-Translate $_)[1] } -Descending |
        Select-Object -First 1
    if ($null -eq $noteDivider) {
        throw 'Trend note divider not found'
    }

    # Keep the note-to-divider gap identical across P2-P4.
    $noteDividerY = $notePosition[1] - $fixedNoteDividerGap
    $dividerPosition = Get-Translate $noteDivider
    Set-Translate $noteDivider $dividerPosition[0] $noteDividerY

    $plotBottom = $updatedChildren |
        Where-Object {
            $path = $_.SelectSingleNode("./*[local-name()='path']")
            $position = Get-Translate $_
            $null -ne $path -and
            $position[1] -lt $noteDividerY -and
            $path.GetAttribute('d') -eq 'M 0 0 L 1296 0'
        } |
        Sort-Object { (Get-Translate $_)[1] } -Descending |
        Select-Object -First 1
    if ($null -eq $plotBottom) {
        throw 'Trend plot bottom line not found'
    }
    $plotBottomY = (Get-Translate $plotBottom)[1]

    $dateLabels = @(
        $updatedChildren |
            Where-Object { $_.InnerText.Trim() -match '^\d{2}/\d{2}$' } |
            Sort-Object { (Get-Translate $_)[0] }
    )
    if ($dateLabels.Count -eq 0) {
        throw 'Trend date labels not found'
    }

    $labelRules = @(
        @{ Pattern = '^下载侧T3 \d'; X = 350 },
        @{ Pattern = '^收入侧US\+T1 \d'; X = 800 },
        @{ Pattern = '^收入数据覆盖率\d'; X = 1250 }
    )
    $endpointLabels = @()
    foreach ($rule in $labelRules) {
        $node = $updatedChildren |
            Where-Object { $_.InnerText.Trim() -match $rule.Pattern } |
            Select-Object -First 1
        if ($null -eq $node) {
            throw "Trend endpoint label not found: $($rule.Pattern)"
        }

        $endpointLabels += @{
            Node = $node
            X = $rule.X
        }
    }

    # Keep the dates in the first lower row. Position the endpoint-label text
    # boxes so the visible gaps on both sides are equal. The endpoint text
    # height appears on both sides and cancels; the date text height adds one
    # quarter to the midpoint.
    $gridHeight = $noteDividerY - $plotBottomY
    $dateRowCenter = $plotBottomY + ($gridHeight / 4)
    $dateFontSize = [double]::Parse(
        $dateLabels[0].SelectSingleNode(".//*[local-name()='text']").GetAttribute('font-size'),
        $culture
    )
    $endpointRowCenter = (($dateRowCenter + $noteDividerY) / 2) + ($dateFontSize / 4)

    foreach ($dateLabel in $dateLabels) {
        # Preserve the source x offsets so edge dates do not collide after recentering.
        Set-TextVerticalCenter $dateLabel $dateRowCenter
    }

    for ($index = 0; $index -lt $endpointLabels.Count; $index++) {
        $label = $endpointLabels[$index]
        Set-TextCenter $label.Node $label.X $endpointRowCenter
    }
}

function Update-CategoryChart {
    param([System.Xml.XmlElement]$Main)

    $children = Get-ElementChildren $Main
    $existingBottomBoundary = $children |
        Where-Object { $_.GetAttribute('id') -eq 'category-bottom-boundary' } |
        Select-Object -First 1
    if ($null -ne $existingBottomBoundary) {
        [void]$Main.RemoveChild($existingBottomBoundary)
        $children = Get-ElementChildren $Main
    }
    $leftLabels = @(
        '品类',
        'Launcher',
        'PDF阅读器',
        '休闲',
        '壁纸',
        '文件恢复',
        '杀毒软件、清理',
        '超休闲'
    )
    $categoryColumnCenterX = 136.5
    $coverageColumnCenterX = 1354.5

    $bars = @(
        $children |
            Where-Object {
                $rect = $_.SelectSingleNode("./*[local-name()='rect']")
                $null -ne $rect -and
                $rect.GetAttribute('height') -eq '18.9' -and
                $rect.GetAttribute('fill') -in @('#3867b9', '#93c5fd')
            } |
            Sort-Object {
                (Get-Translate $_)[1]
            }
    )
    if ($bars.Count -ne 14) {
        throw "Expected 14 category bars, found $($bars.Count)"
    }

    $firstBarPosition = Get-Translate $bars[0]
    $lastBarPosition = Get-Translate $bars[-1]
    $lastBarRect = $bars[-1].SelectSingleNode("./*[local-name()='rect']")
    $bottomSearchLimit = $lastBarPosition[1] + [double]::Parse(
        $lastBarRect.GetAttribute('height'),
        $culture
    ) + 40
    $expectedAxisWidth = [string]::Format($culture, '{0:0.####}', [double]$contract.category.barWidthAt100)
    $rowBoundaryNodes = @(
        $children |
            Where-Object {
                $path = $_.SelectSingleNode("./*[local-name()='path']")
                $position = Get-Translate $_
                $null -ne $path -and
                $position[1] -ge ($firstBarPosition[1] - 30) -and
                $position[1] -le $bottomSearchLimit -and
                $path.GetAttribute('d') -match "^M 0 0 L (?:1491|$([regex]::Escape($expectedAxisWidth))) 0$"
            } |
            Sort-Object {
                (Get-Translate $_)[1]
            }
    )
    if ($rowBoundaryNodes.Count -ne 8) {
        throw "Expected 8 category row boundaries, found $($rowBoundaryNodes.Count)"
    }

    # The header-to-first-row gap is independent from the seven data rows.
    # Redistribute only the interior row separators so every category row has
    # the same height while retaining the existing top and bottom boundaries.
    $firstBoundary = Get-Translate $rowBoundaryNodes[0]
    $lastBoundary = Get-Translate $rowBoundaryNodes[7]
    $rowHeight = ($lastBoundary[1] - $firstBoundary[1]) / 7
    $rowBoundaries = @()
    for ($index = 0; $index -le 7; $index++) {
        $targetY = $firstBoundary[1] + ($rowHeight * $index)
        $rowBoundaries += $targetY
        if ($index -gt 0 -and $index -lt 7) {
            $boundaryPosition = Get-Translate $rowBoundaryNodes[$index]
            Set-Translate $rowBoundaryNodes[$index] $boundaryPosition[0] $targetY
        }
    }

    $rowPlans = @()
    for ($row = 0; $row -lt 7; $row++) {
        $topBar = $bars[$row * 2]
        $bottomBar = $bars[($row * 2) + 1]
        $topPosition = Get-Translate $topBar
        $bottomPosition = Get-Translate $bottomBar
        $bottomRect = $bottomBar.SelectSingleNode("./*[local-name()='rect']")
        $bottomHeight = [double]::Parse(
            $bottomRect.GetAttribute('height'),
            $culture
        )

        $currentCenter = (
            $topPosition[1] +
            $bottomPosition[1] +
            $bottomHeight
        ) / 2
        $targetCenter = (
            $rowBoundaries[$row] +
            $rowBoundaries[$row + 1]
        ) / 2

        $rowPlans += @{
            CurrentCenter = $currentCenter
            DeltaY = $targetCenter - $currentCenter
            Bars = @($topBar, $bottomBar)
        }
    }

    foreach ($plan in $rowPlans) {
        foreach ($bar in $plan.Bars) {
            Move-Node $bar 0 $plan.DeltaY
        }
    }

    $bodyLabels = @(
        $children |
            Where-Object {
                $label = $_.InnerText.Trim()
                $position = Get-Translate $_
                (
                    $leftLabels -contains $label -or
                    $label -match '^\d+(?:\.\d+)?%$'
                ) -and
                $label -ne '品类' -and
                $position[1] -gt 320 -and
                $position[1] -lt 800
            }
    )
    foreach ($node in $bodyLabels) {
        $position = Get-Translate $node
        $textCenterY = $position[1] + 14.118
        $plan = $rowPlans |
            Sort-Object {
                [math]::Abs($_.CurrentCenter - $textCenterY)
            } |
            Select-Object -First 1
        Move-Node $node 0 $plan.DeltaY
    }

    foreach ($node in $children) {
        $label = $node.InnerText.Trim()
        $position = Get-Translate $node

        if ($leftLabels -contains $label) {
            Set-Translate $node $categoryColumnCenterX $position[1]
            Set-TextHorizontalAlignment $node 'middle'
        }
        elseif (
            $label -eq '收入覆盖率' -or
            ($position[0] -gt 1300 -and $label -match '^\d+(?:\.\d+)?%$')
        ) {
            Set-Translate $node $coverageColumnCenterX $position[1]
            Set-TextHorizontalAlignment $node 'middle'
        }
    }

    $note = (Get-ElementChildren $Main) |
        Where-Object { $_.InnerText.Trim().StartsWith('同一品类中') } |
        Select-Object -First 1
    if ($null -eq $note) {
        throw 'Category note not found'
    }
    Set-FixedNoteBottom $Main $note
    $notePosition = Get-Translate $note
    $noteDivider = (Get-ElementChildren $Main) |
        Where-Object {
            $path = $_.SelectSingleNode("./*[local-name()='path']")
            $position = Get-Translate $_
            $null -ne $path -and
            $position[1] -lt $notePosition[1] -and
            $path.GetAttribute('d') -eq 'M 0 0 L 1491 0'
        } |
        Sort-Object { (Get-Translate $_)[1] } -Descending |
        Select-Object -First 1
    if ($null -eq $noteDivider) {
        throw 'Category note divider not found'
    }
    $dividerPosition = Get-Translate $noteDivider
    Set-Translate $noteDivider $dividerPosition[0] ($notePosition[1] - $fixedNoteDividerGap)

    # Preserve the dark plot axis, then add the missing full-width bottom edge
    # so the final category row is bounded like every preceding row.
    $bottomBoundary = $Main.OwnerDocument.CreateElement('g', $Main.NamespaceURI)
    $bottomBoundary.SetAttribute('id', 'category-bottom-boundary')
    Set-Translate $bottomBoundary 0 $rowBoundaries[7]
    $bottomPath = $Main.OwnerDocument.CreateElement('path', $Main.NamespaceURI)
    $bottomPath.SetAttribute('fill', 'none')
    $bottomPath.SetAttribute('stroke', '#e8edf3')
    $bottomPath.SetAttribute('stroke-width', '1')
    $bottomPath.SetAttribute('stroke-linecap', 'round')
    $bottomPath.SetAttribute('stroke-linejoin', 'round')
    $bottomPath.SetAttribute('d', 'M 0 0 L 1491 0')
    [void]$bottomBoundary.AppendChild($bottomPath)
    [void]$Main.AppendChild($bottomBoundary)
}

function Update-RegionChart {
    param([System.Xml.XmlElement]$Main)

    $children = Get-ElementChildren $Main
    $note = $children |
        Where-Object {
            $_.InnerText.Trim().StartsWith('IN、拉美、东南亚为可重叠观察组')
        } |
        Select-Object -First 1
    if ($null -eq $note) {
        throw 'Supplementary-region note not found'
    }

    Set-FixedNoteBottom $Main $note
    $notePosition = Get-Translate $note
    $card = $children |
        Where-Object {
            $rect = $_.SelectSingleNode("./*[local-name()='rect']")
            $null -ne $rect -and
            [double]::Parse($rect.GetAttribute('width'), $culture) -gt 1200 -and
            (Get-Translate $_)[1] -lt $notePosition[1]
        } |
        Sort-Object { (Get-Translate $_)[1] } -Descending |
        Select-Object -First 1
    if ($null -ne $card) {
        [void]$Main.RemoveChild($card)
    }

    $downloadBars = @(
        (Get-ElementChildren $Main) |
            Where-Object {
                $rect = $_.SelectSingleNode("./*[local-name()='rect']")
                $null -ne $rect -and
                $rect.GetAttribute('fill') -eq '#2f67e8' -and
                $rect.GetAttribute('height') -eq '48.4'
            } |
            Sort-Object { (Get-Translate $_)[1] }
    )
    $incomeBars = @(
        (Get-ElementChildren $Main) |
            Where-Object {
                $rect = $_.SelectSingleNode("./*[local-name()='rect']")
                $null -ne $rect -and
                $rect.GetAttribute('fill') -eq '#f05a00' -and
                $rect.GetAttribute('height') -eq '48.4'
            } |
            Sort-Object { (Get-Translate $_)[1] }
    )
    $valueLabels = @(
        (Get-ElementChildren $Main) |
            Where-Object {
                $text = $_.SelectSingleNode(".//*[local-name()='text']")
                $position = Get-Translate $_
                $null -ne $text -and
                $text.GetAttribute('fill') -eq '#ffffff' -and
                $_.InnerText.Trim() -match '^\d+(?:\.\d+)?%$' -and
                $position[1] -gt 300
            }
    )
    $downloadLabels = @(
        $valueLabels |
            Where-Object { (Get-Translate $_)[0] -lt 800 } |
            Sort-Object { (Get-Translate $_)[1] }
    )
    $incomeLabels = @(
        $valueLabels |
            Where-Object { (Get-Translate $_)[0] -ge 800 } |
            Sort-Object { (Get-Translate $_)[1] }
    )
    if ($downloadBars.Count -ne 4 -or $incomeBars.Count -ne 4) {
        throw "Expected four bars per side, found $($downloadBars.Count) and $($incomeBars.Count)"
    }
    if ($downloadLabels.Count -ne 4 -or $incomeLabels.Count -ne 4) {
        throw "Expected four value labels per side, found $($downloadLabels.Count) and $($incomeLabels.Count)"
    }

    $regionNames = @(
        (Get-ElementChildren $Main) |
            Where-Object { $_.InnerText.Trim() -in @('US', 'IN', '拉美', '东南亚') } |
            Sort-Object { (Get-Translate $_)[1] }
    )
    if ($regionNames.Count -ne 4) {
        throw "Expected four supplementary-region names, found $($regionNames.Count)"
    }

    $rowCenters = @()
    for ($index = 0; $index -lt 4; $index++) {
        $position = Get-Translate $downloadBars[$index]
        $rect = $downloadBars[$index].SelectSingleNode("./*[local-name()='rect']")
        $height = [double]::Parse($rect.GetAttribute('height'), $culture)
        $rowCenters += $position[1] + ($height / 2)
    }
    $rowStep = ($rowCenters[-1] - $rowCenters[0]) / 3
    for ($index = 0; $index -lt 4; $index++) {
        $rowCenters[$index] = $rowCenters[0] + ($rowStep * $index)
    }

    # Keep the note on the fixed content-bottom anchor, then move the complete
    # region plot as one unit so the lower boundary remains aligned with it.
    $noteDividerY = $notePosition[1] - $fixedNoteDividerGap
    $rowShift = ($noteDividerY - ($rowStep / 2)) - $rowCenters[-1]
    for ($index = 0; $index -lt $rowCenters.Count; $index++) {
        $rowCenters[$index] += $rowShift
    }

    $plotGroups = @(
        (Get-ElementChildren $Main) |
            Where-Object {
                $paths = @($_.SelectNodes(".//*[local-name()='path']"))
                (@($paths | Where-Object { $_.GetAttribute('d') -eq 'M 0 0 L 0 490.6' }).Count -gt 0) -or
                (@($paths | Where-Object { $_.GetAttribute('d') -eq 'M 0 0 L 1364 0' }).Count -ge 3)
            }
    )
    foreach ($plotGroup in $plotGroups) {
        Move-Node $plotGroup 0 $rowShift
    }

    $scaleLabels = @(
        (Get-ElementChildren $Main) |
            Where-Object {
                $_.InnerText.Trim() -match '^(?:0|10|20|30|35)%$' -and
                (Get-Translate $_)[1] -gt 250
            }
    )
    foreach ($scaleLabel in $scaleLabels) {
        Move-Node $scaleLabel 0 $rowShift
    }

    $existingTopBoundary = $Main.SelectSingleNode(".//*[local-name()='g'][@id='region-top-boundary']")
    if ($null -ne $existingTopBoundary) {
        [void]$existingTopBoundary.ParentNode.RemoveChild($existingTopBoundary)
    }

    $rowBoundaryGroup = (Get-ElementChildren $Main) |
        Where-Object {
            @($_.SelectNodes(".//*[local-name()='path'][@d='M 0 0 L 1364 0']")).Count -eq 3
        } |
        Select-Object -First 1
    if ($null -ne $rowBoundaryGroup) {
        $boundaryGroupPosition = Get-Translate $rowBoundaryGroup
        $rowBoundaries = @(
            (Get-ElementChildren $rowBoundaryGroup) |
                Where-Object {
                    $path = $_.SelectSingleNode("./*[local-name()='path']")
                    $null -ne $path -and $path.GetAttribute('d') -eq 'M 0 0 L 1364 0'
                } |
                Sort-Object { (Get-Translate $_)[1] }
        )
        for ($index = 0; $index -lt $rowBoundaries.Count; $index++) {
            $boundaryPosition = Get-Translate $rowBoundaries[$index]
            $targetY = (($rowCenters[$index] + $rowCenters[$index + 1]) / 2) - $boundaryGroupPosition[1]
            Set-Translate $rowBoundaries[$index] $boundaryPosition[0] $targetY
        }

        $topBoundary = $Main.OwnerDocument.CreateElement('g', $Main.NamespaceURI)
        $topBoundary.SetAttribute('id', 'region-top-boundary')
        $topBoundaryY = ($rowCenters[0] - ($rowStep / 2)) - $boundaryGroupPosition[1]
        Set-Translate $topBoundary 0 $topBoundaryY
        $topBoundaryPath = $Main.OwnerDocument.CreateElement('path', $Main.NamespaceURI)
        $topBoundaryPath.SetAttribute('fill', 'none')
        $topBoundaryPath.SetAttribute('stroke', '#e5e7eb')
        $topBoundaryPath.SetAttribute('stroke-width', '1')
        $topBoundaryPath.SetAttribute('stroke-linecap', 'round')
        $topBoundaryPath.SetAttribute('stroke-linejoin', 'round')
        $topBoundaryPath.SetAttribute('d', 'M 0 0 L 1364 0')
        [void]$topBoundary.AppendChild($topBoundaryPath)
        [void]$rowBoundaryGroup.InsertBefore($topBoundary, $rowBoundaryGroup.FirstChild)
    }

    $regionBottomBoundaryY = $rowCenters[-1] + ($rowStep / 2)
    if ([math]::Abs($regionBottomBoundaryY - $noteDividerY) -gt 0.0001) {
        throw 'Region lower boundary is not aligned with note divider'
    }

    # Move labels 5px farther inward than the source 12px padding.
    $innerPadding = 17
    for ($index = 0; $index -lt 4; $index++) {
        $downloadBar = $downloadBars[$index]
        $downloadRect = $downloadBar.SelectSingleNode("./*[local-name()='rect']")
        $downloadPosition = Get-Translate $downloadBar
        $downloadWidth = [double]::Parse($downloadRect.GetAttribute('width'), $culture)
        $downloadHeight = [double]::Parse($downloadRect.GetAttribute('height'), $culture)
        Set-Translate $downloadBar $downloadPosition[0] ($rowCenters[$index] - ($downloadHeight / 2))
        Set-TextCenter $downloadLabels[$index] (
            $downloadPosition[0] + $downloadWidth - $innerPadding
        ) $rowCenters[$index]
        Set-TextHorizontalAlignment $downloadLabels[$index] 'end'

        $incomeBar = $incomeBars[$index]
        $incomeRect = $incomeBar.SelectSingleNode("./*[local-name()='rect']")
        $incomePosition = Get-Translate $incomeBar
        $incomeHeight = [double]::Parse($incomeRect.GetAttribute('height'), $culture)
        Set-Translate $incomeBar $incomePosition[0] ($rowCenters[$index] - ($incomeHeight / 2))
        Set-TextCenter $incomeLabels[$index] ($incomePosition[0] + $innerPadding) $rowCenters[$index]
        Set-TextHorizontalAlignment $incomeLabels[$index] 'start'

        Set-TextCenter $regionNames[$index] 770 $rowCenters[$index]
    }

    Set-Translate $note 0 $notePosition[1]
    Set-TextHorizontalAlignment $note 'start'
    $existingDivider = (Get-ElementChildren $Main) |
        Where-Object { $_.GetAttribute('id') -eq 'region-note-divider' } |
        Select-Object -First 1
    if ($null -ne $existingDivider) {
        [void]$Main.RemoveChild($existingDivider)
    }
    $divider = $Main.OwnerDocument.CreateElement('g', $Main.NamespaceURI)
    $divider.SetAttribute('id', 'region-note-divider')
    Set-Translate $divider 0 $noteDividerY
    $dividerPath = $Main.OwnerDocument.CreateElement('path', $Main.NamespaceURI)
    $dividerPath.SetAttribute('fill', 'none')
    $dividerPath.SetAttribute('stroke', '#d9e1ea')
    $dividerPath.SetAttribute('stroke-width', '1')
    $dividerPath.SetAttribute('stroke-linecap', 'round')
    $dividerPath.SetAttribute('stroke-linejoin', 'round')
    $dividerPath.SetAttribute('d', 'M 0 0 L 1491 0')
    [void]$divider.AppendChild($dividerPath)
    [void]$Main.InsertBefore($divider, $note)
}

$chartHandlers = @{
    '01-global.svg' = ${function:Update-GlobalChart}
    '02-trend.svg' = ${function:Update-TrendChart}
    '03-category.svg' = ${function:Update-CategoryChart}
    '04-regions.svg' = ${function:Update-RegionChart}
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$filesToProcess = if ($ChartFile.Count -gt 0) {
    foreach ($fileName in $ChartFile) {
        if (-not $chartHandlers.ContainsKey($fileName)) {
            throw "Unsupported chart file '$fileName'"
        }
        $fileName
    }
}
else {
    @($chartHandlers.Keys)
}

foreach ($fileName in $filesToProcess) {
    $sourcePath = Join-Path $InputDir $fileName
    $targetPath = Join-Path $OutputDir $fileName
    [xml]$svg = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8

    $root = $svg.DocumentElement
    $groups = Get-ElementChildren $root
    if ($groups.Count -lt 2) {
        throw "Expected background and content groups in $fileName"
    }

    $main = $groups[1]
    $mainPosition = Get-Translate $main
    $headerChildren = Get-ElementChildren $main
    $headerRulePosition = Get-Translate $headerChildren[2]
    $subtitleText = $headerChildren[1].SelectSingleNode(".//*[local-name()='text']")
    $alreadyNormalized =
        [math]::Abs($mainPosition[1] - $fixedContentTop) -lt 0.0001 -and
        $headerRulePosition[1] -gt 170 -and
        $subtitleText.GetAttribute('dominant-baseline') -eq 'middle'
    Set-FixedCanvas $root
    Set-FixedContentFrame $main
    if (-not $alreadyNormalized) {
        Apply-VerticalRhythm $main
    }
    Set-FixedHeaderRhythm $main

    $handler = $chartHandlers[$fileName]
    if ($null -ne $handler -and (-not $alreadyNormalized -or $fileName -in @('02-trend.svg', '03-category.svg', '04-regions.svg'))) {
        & $handler $main
    }

    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $settings.Indent = $false
    $settings.OmitXmlDeclaration = $true
    $writer = [System.Xml.XmlWriter]::Create($targetPath, $settings)
    try {
        $svg.Save($writer)
    }
    finally {
        $writer.Dispose()
    }
}
