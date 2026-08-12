param(
    [Parameter(Mandatory = $true)]
    [string]$InputDir
)

$ErrorActionPreference = 'Stop'
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$contractPath = Join-Path $PSScriptRoot '..\references\chart-layout-contract.json'
$contract = Get-Content -LiteralPath $contractPath -Raw -Encoding UTF8 | ConvertFrom-Json
$tolerance = 0.001
$expectedFiles = @(
    '01-global.svg',
    '02-trend.svg',
    '03-category.svg',
    '04-countries.svg',
    '05-regions.svg'
)
$errors = [System.Collections.Generic.List[string]]::new()

function Add-CheckError {
    param([string]$Message)

    [void]$script:errors.Add($Message)
}

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

function Get-AbsolutePosition {
    param(
        [System.Xml.XmlElement]$Node,
        [System.Xml.XmlElement]$Root
    )

    $x = 0.0
    $y = 0.0
    $current = $Node
    while ($null -ne $current -and $current -ne $Root) {
        if ($current.NodeType -eq 'Element' -and $current.HasAttribute('transform')) {
            $position = Get-Translate $current
            $x += $position[0]
            $y += $position[1]
        }
        $current = $current.ParentNode
    }

    if ($current -ne $Root) {
        throw "Root ancestor not found for node $($Node.GetAttribute('id'))"
    }

    return @($x, $y)
}

function Get-TextNode {
    param([System.Xml.XmlElement]$Node)

    return $Node.SelectSingleNode(".//*[local-name()='text']")
}

function Get-TextLabel {
    param([System.Xml.XmlElement]$Node)

    return (($Node.InnerText -replace '\s+', ' ').Trim())
}

function Get-EstimatedTextWidth {
    param([System.Xml.XmlElement]$Node)

    $textNode = Get-TextNode $Node
    if ($null -eq $textNode) {
        throw "Text node not found on node $($Node.GetAttribute('id'))"
    }
    $fontSize = [double]::Parse($textNode.GetAttribute('font-size'), $culture)
    $width = 0.0
    foreach ($character in (Get-TextLabel $Node).ToCharArray()) {
        $codePoint = [int][char]$character
        $width += if ($codePoint -ge 0x2E80 -and $codePoint -le 0x9FFF) {
            $fontSize
        }
        else {
            $fontSize * 0.6
        }
    }
    return $width
}

function Get-NodeHorizontalBounds {
    param(
        [System.Xml.XmlElement]$Node,
        [System.Xml.XmlElement]$Root
    )

    $position = Get-AbsolutePosition $Node $Root
    $rect = $Node.SelectSingleNode('./*[local-name()="rect"]')
    if ($null -ne $rect) {
        $x = if ($rect.HasAttribute('x')) { [double]::Parse($rect.GetAttribute('x'), $culture) } else { 0.0 }
        $width = [double]::Parse($rect.GetAttribute('width'), $culture)
        return [pscustomobject]@{
            Left = $position[0] + $x
            Right = $position[0] + $x + $width
        }
    }

    $ellipse = $Node.SelectSingleNode('./*[local-name()="ellipse" or local-name()="circle"]')
    if ($null -ne $ellipse) {
        $center = [double]::Parse($ellipse.GetAttribute('cx'), $culture)
        $radius = if ($ellipse.LocalName -eq 'circle') {
            [double]::Parse($ellipse.GetAttribute('r'), $culture)
        }
        else {
            [double]::Parse($ellipse.GetAttribute('rx'), $culture)
        }
        return [pscustomobject]@{
            Left = $position[0] + $center - $radius
            Right = $position[0] + $center + $radius
        }
    }

    $path = $Node.SelectSingleNode('./*[local-name()="path"]')
    if ($null -ne $path -and $path.GetAttribute('d') -match 'M\s*0\s*0\s*L\s*([-+0-9.eE]+)\s*0') {
        $endX = [double]::Parse($Matches[1], $culture)
        return [pscustomobject]@{
            Left = $position[0] + [math]::Min(0, $endX)
            Right = $position[0] + [math]::Max(0, $endX)
        }
    }

    $text = $Node.SelectSingleNode('.//*[local-name()="text"]')
    if ($null -ne $text) {
        $textX = if ($text.HasAttribute('x')) { [double]::Parse($text.GetAttribute('x'), $culture) } else { 0.0 }
        $width = Get-EstimatedTextWidth $Node
        $anchor = $text.GetAttribute('text-anchor')
        if ($anchor -eq 'middle') {
            return [pscustomobject]@{
                Left = $position[0] + $textX - ($width / 2)
                Right = $position[0] + $textX + ($width / 2)
            }
        }
        if ($anchor -eq 'end') {
            return [pscustomobject]@{
                Left = $position[0] + $textX - $width
                Right = $position[0] + $textX
            }
        }
        return [pscustomobject]@{
            Left = $position[0] + $textX
            Right = $position[0] + $textX + $width
        }
    }

    throw "Cannot estimate horizontal bounds for $($Node.GetAttribute('id'))"
}

function New-LegendItem {
    param(
        [System.Xml.XmlElement[]]$Nodes,
        [System.Xml.XmlElement]$Root
    )

    $parts = @()
    foreach ($node in @($Nodes)) {
        $bounds = Get-NodeHorizontalBounds $node $Root
        $parts += [pscustomobject]@{
            Left = $bounds.Left
            Right = $bounds.Right
        }
    }
    if ($parts.Count -eq 0) {
        throw 'Legend item must contain at least one element'
    }
    return [pscustomobject]@{
        Left = ($parts | Measure-Object -Property Left -Minimum).Minimum
        Right = ($parts | Measure-Object -Property Right -Maximum).Maximum
    }
}

function Assert-LegendLayout {
    param(
        [object[]]$Items,
        [double]$ExpectedCenter,
        [string]$Label
    )

    if (@($Items).Count -eq 0) {
        Add-CheckError "$Label has no legend items"
        return
    }
    $orderedItems = @($Items | Sort-Object Left)
    $left = ($orderedItems | Measure-Object -Property Left -Minimum).Minimum
    $right = ($orderedItems | Measure-Object -Property Right -Maximum).Maximum
    Assert-Approx (($left + $right) / 2) $ExpectedCenter "$Label overall center"

    $minimumGap = [double]$contract.spacing.minimumElementGap
    for ($index = 0; $index -lt ($orderedItems.Count - 1); $index++) {
        $current = $orderedItems[$index]
        $next = $orderedItems[$index + 1]
        $actualGap = $next.Left - $current.Right
        if ($actualGap + $tolerance -lt $minimumGap) {
            Add-CheckError (
                "$Label gap {0} is {1:0.####}, below minimum {2:0.####}" -f
                    ($index + 1), $actualGap, $minimumGap
            )
        }
    }
}

function Get-PathNode {
    param([System.Xml.XmlElement]$Node)

    return $Node.SelectSingleNode("./*[local-name()='path']")
}

function Assert-Approx {
    param(
        [double]$Actual,
        [double]$Expected,
        [string]$Label
    )

    if ([math]::Abs($Actual - $Expected) -gt $tolerance) {
        Add-CheckError ("{0}: expected {1:0.####}, got {2:0.####}" -f $Label, $Expected, $Actual)
    }
}

function Get-TextBaseline {
    param([System.Xml.XmlElement]$Node)

    $text = Get-TextNode $Node
    $span = $text.SelectSingleNode(".//*[local-name()='tspan'][@y]")
    if ($null -eq $span) {
        throw "Text baseline not found on node $($Node.GetAttribute('id'))"
    }

    return [double]::Parse($span.GetAttribute('y'), $culture)
}

function Assert-Header {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Root,
        [string]$FileName
    )

    $children = Get-ElementChildren $Main
    if ($children.Count -lt 3) {
        Add-CheckError "${FileName}: header nodes are missing"
        return
    }

    $title = $children[0]
    $subtitle = $children[1]
    $rule = $children[2]
    $titlePosition = Get-AbsolutePosition $title $Root
    $subtitlePosition = Get-AbsolutePosition $subtitle $Root
    $rulePosition = Get-AbsolutePosition $rule $Root
    $titleText = Get-TextNode $title
    $subtitleText = Get-TextNode $subtitle
    $rulePath = Get-PathNode $rule

    Assert-Approx $titlePosition[0] 50 "$FileName title left edge"
    Assert-Approx $subtitlePosition[0] 50 "$FileName subtitle left edge"
    Assert-Approx $rulePosition[0] 50 "$FileName top divider left edge"
    Assert-Approx ($titlePosition[1] + (Get-TextBaseline $title)) 82.589 "$FileName title lower anchor"
    Assert-Approx $subtitlePosition[1] 148.589 "$FileName subtitle center"
    Assert-Approx $rulePosition[1] 214.589 "$FileName top divider Y"
    Assert-Approx ($subtitlePosition[1] - ($titlePosition[1] + (Get-TextBaseline $title))) 66 "$FileName title-to-subtitle gap"
    Assert-Approx ($rulePosition[1] - $subtitlePosition[1]) 66 "$FileName subtitle-to-divider gap"

    if ($titleText.GetAttribute('font-size') -ne '56') {
        Add-CheckError "$FileName title font size is not 56"
    }
    if ($subtitleText.GetAttribute('font-size') -ne '24') {
        Add-CheckError "$FileName subtitle font size is not 24"
    }
    if ($subtitleText.GetAttribute('dominant-baseline') -ne 'middle') {
        Add-CheckError "$FileName subtitle is not vertically centered"
    }
    if ($null -eq $rulePath) {
        Add-CheckError "$FileName top divider path is missing"
    }
}

function Get-ShapeCenterY {
    param(
        [System.Xml.XmlElement]$Shape,
        [System.Xml.XmlElement]$Root
    )

    $position = Get-AbsolutePosition $Shape $Root
    if ($Shape.LocalName -in @('circle', 'ellipse')) {
        $center = [double]$Shape.GetAttribute('cy')
    }
    else {
        $y = if ($Shape.HasAttribute('y')) { [double]$Shape.GetAttribute('y') } else { 0 }
        $height = [double]$Shape.GetAttribute('height')
        $center = $y + ($height / 2)
    }

    return $position[1] + $center
}

function Assert-TopContentAnchor {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Root,
        [string]$FileName
    )

    $children = Get-ElementChildren $Main
    $rulePosition = Get-AbsolutePosition $children[2] $Root
    $anchorY = $null

    switch ($FileName) {
        '01-global.svg' {
            $legend = $children | Where-Object { (Get-TextLabel $_) -eq 'UST1T2T3其他' } | Select-Object -First 1
            if ($null -ne $legend) {
                $shape = $legend.SelectSingleNode(".//*[local-name()='rect'][@width <= 20]")
                if ($null -ne $shape) { $anchorY = Get-ShapeCenterY $shape $Root }
            }
        }
        '03-category.svg' {
            $legend = $children | Where-Object { (Get-TextLabel $_) -eq '下载T2+T3收入US+T1' } | Select-Object -First 1
            if ($null -ne $legend) {
                $shape = $legend.SelectSingleNode(".//*[local-name()='rect'][@width <= 20]")
                if ($null -ne $shape) { $anchorY = Get-ShapeCenterY $shape $Root }
            }
        }
        '02-trend.svg' {
            $anchor = $children | Where-Object {
                $path = Get-PathNode $_
                $null -ne $path -and $path.GetAttribute('d') -eq 'M 0 0 L 28.08 0'
            } | Select-Object -First 1
            if ($null -ne $anchor) { $anchorY = (Get-AbsolutePosition $anchor $Root)[1] }
        }
        '04-countries.svg' {
            $anchor = $children | Where-Object {
                $shape = $_.SelectSingleNode('./*[local-name()="rect"]')
                $null -ne $shape -and [double]$shape.GetAttribute('width') -eq 17.6 -and [double]$shape.GetAttribute('height') -eq 17.6
            } | Select-Object -First 1
            if ($null -ne $anchor) {
                $shape = $anchor.SelectSingleNode('./*[local-name()="rect"]')
                $anchorY = Get-ShapeCenterY $shape $Root
            }
        }
        '05-regions.svg' {
            $anchor = $children | Where-Object {
                $shape = $_.SelectSingleNode("./*[local-name()='ellipse' or local-name()='circle']")
                $null -ne $shape -and $shape.GetAttribute('fill') -eq '#2f67e8'
            } | Select-Object -First 1
            if ($null -ne $anchor) {
                $shape = $anchor.SelectSingleNode("./*[local-name()='ellipse' or local-name()='circle']")
                $anchorY = Get-ShapeCenterY $shape $Root
            }
        }
    }

    if ($null -eq $anchorY) {
        Add-CheckError "$FileName first content anchor is missing"
    }
    else {
        Assert-Approx $anchorY ($rulePosition[1] + 49) "$FileName divider-to-content gap"
    }
}

function Assert-CategoryCountryRows {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Root
    )

    $children = Get-ElementChildren $Main
    $expectedNames = @('Launcher', 'PDF阅读器', '休闲', '壁纸', '文件恢复', '杀毒软件、清理', '超休闲')
    $nameNodes = @($children | Where-Object { (Get-TextLabel $_) -in $expectedNames })
    if ($nameNodes.Count -ne 7) {
        Add-CheckError "04-countries.svg must contain seven category labels, got $($nameNodes.Count)"
    }
    foreach ($name in $expectedNames) {
        if (@($nameNodes | Where-Object { (Get-TextLabel $_) -eq $name }).Count -ne 1) {
            Add-CheckError "04-countries.svg category label is missing or duplicated: $name"
        }
    }

    $legendLabels = @($children | Where-Object { (Get-TextLabel $_) -match '^[A-Z]{2}$' } | ForEach-Object { Get-TextLabel $_ } | Sort-Object -Unique)
    if ($legendLabels.Count -lt 5) {
        Add-CheckError '04-countries.svg must contain at least five country-code legend labels'
    }
    $legendMarkers = @($children | Where-Object {
        $rect = $_.SelectSingleNode('./*[local-name()="rect"]')
        $null -ne $rect -and [double]$rect.GetAttribute('width') -eq 17.6 -and [double]$rect.GetAttribute('height') -eq 17.6
    })
    if ($legendMarkers.Count -ne $legendLabels.Count) {
        Add-CheckError "04-countries.svg legend marker count must match labels, got $($legendMarkers.Count) markers and $($legendLabels.Count) labels"
    }

    $bars = @($children | Where-Object {
        $_.LocalName -eq 'rect' -and
        [double]$_.GetAttribute('height') -eq 44 -and
        [double]$_.GetAttribute('width') -gt 0
    })
    if ($bars.Count -lt 35 -or $bars.Count -gt 42) {
        Add-CheckError "04-countries.svg must contain five country bars plus an optional other segment per row, got $($bars.Count)"
        return
    }
    $rowYs = @($bars | ForEach-Object { [math]::Round([double]$_.GetAttribute('y'), 3) } | Sort-Object -Unique)
    if ($rowYs.Count -ne 7) {
        Add-CheckError "04-countries.svg must contain seven bar rows, got $($rowYs.Count)"
    }
    foreach ($rowY in $rowYs) {
        $rowBars = @($bars | Where-Object { [math]::Abs([double]$_.GetAttribute('y') - $rowY) -le $tolerance } | Sort-Object { [double]$_.GetAttribute('x') })
        if ($rowBars.Count -lt 5 -or $rowBars.Count -gt 6) {
            Add-CheckError "04-countries.svg row at y=$rowY must contain five country bars plus at most one other segment, got $($rowBars.Count)"
            continue
        }
        $left = [double]$rowBars[0].GetAttribute('x')
        $right = [double]$rowBars[-1].GetAttribute('x') + [double]$rowBars[-1].GetAttribute('width')
        Assert-Approx $left 230 '04-countries first bar left edge'
        if ([math]::Abs($right - 1430) -gt 0.2) {
            Add-CheckError "04-countries last bar right edge must be within 0.2 of 1430, got $right"
        }
        if ($rowBars.Count -eq 6) {
            $otherBars = @($rowBars | Where-Object { $_.GetAttribute('fill') -eq '#e4e7ec' })
            if ($otherBars.Count -ne 1) {
                Add-CheckError "04-countries row at y=$rowY must have one #e4e7ec other segment"
            }
        }
    }

    $noteDivider = $children | Where-Object { $_.GetAttribute('id') -eq 'note-divider' } | Select-Object -First 1
    if ($null -eq $noteDivider) {
        Add-CheckError '04-countries.svg note divider is missing'
    }
    else {
        $path = Get-PathNode $noteDivider
        if ($null -eq $path -or $path.GetAttribute('d') -ne 'M 0 0 L 1491 0') {
            Add-CheckError '04-countries.svg note divider width is not 1491'
        }
    }
    $notes = @($children | Where-Object { (Get-TextLabel $_) -match '^每个品类展示下载侧T2/T3范围内Top5重点国家' })
    if ($notes.Count -ne 1) {
        Add-CheckError '04-countries.svg note is missing'
    }
}

function Assert-TextRules {
    param(
        [System.Xml.XmlElement]$Main,
        [string]$FileName
    )

    foreach ($text in @($Main.SelectNodes(".//*[local-name()='text']"))) {
        $size = [double]$text.GetAttribute('font-size')
        if ($size -lt 24) {
            Add-CheckError "$FileName has visible text below 24px"
        }
        if ($size -eq 24 -and $text.GetAttribute('fill') -eq '#ffffff' -and $text.GetAttribute('font-weight') -eq 'bold') {
            Add-CheckError "$FileName has bold white bar data"
        }
    }

    if ((@($Main.SelectNodes(".//*[local-name()='text']") | ForEach-Object { $_.InnerText }) -join '') -match '100%堆叠') {
        Add-CheckError "$FileName still contains forbidden 100% stacked label"
    }
}

function Assert-GlobalChart {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Root
    )

    $children = Get-ElementChildren $Main
    $legend = $children | Where-Object { (Get-TextLabel $_) -eq 'UST1T2T3其他' } | Select-Object -First 1
    if ($null -eq $legend) {
        Add-CheckError '01-global.svg legend is missing'
    }
    else {
        $legendLabels = @(
            $legend.SelectNodes('.//*[local-name()="text"]') |
                ForEach-Object { $_.InnerText.Trim() }
        )
        $expectedLabels = @('US', 'T1', 'T2', 'T3', '其他')
        if ($legendLabels.Count -ne 5 -or (@($expectedLabels | Where-Object { $legendLabels -notcontains $_ }).Count -gt 0)) {
            Add-CheckError '01-global.svg legend must contain US, T1, T2, T3 and 其他'
        }
        $markers = @($legend.SelectNodes('.//*[local-name()="rect"][@width="17.6"]'))
        if ($markers.Count -ne 5) {
            Add-CheckError '01-global.svg legend markers are incomplete'
        }
        $legendChildren = Get-ElementChildren $legend
        if ($legendChildren.Count -ne 10) {
            Add-CheckError '01-global.svg legend marker-text pairs are incomplete'
        }
        else {
            $legendItems = @()
            for ($index = 0; $index -lt 5; $index++) {
                $legendItems += New-LegendItem @(
                    $legendChildren[$index * 2],
                    $legendChildren[($index * 2) + 1]
                ) $Root
            }
            $mainPosition = Get-AbsolutePosition $Main $Root
            Assert-LegendLayout $legendItems ($mainPosition[0] + [double]$contract.global.legendCenterX) '01-global.svg legend'
        }
    }

    $fills = @('#5b5ce2', '#20a7a0', '#63bce3', '#3867b9', '#cbd5e1')
    $segments = @($children | Where-Object {
        $rect = Get-PathNode $_
        $rect = $_.SelectSingleNode('./*[local-name()="rect"]')
        $null -ne $rect -and $rect.GetAttribute('width') -eq '220' -and $fills -contains $rect.GetAttribute('fill')
    })
    if ($segments.Count -ne 10) {
        Add-CheckError '01-global.svg main segment count is not ten'
        return
    }

    foreach ($side in @(
        @{ Name = 'download'; X = 352; MinX = 0; MaxX = 800 },
        @{ Name = 'income'; X = 968; MinX = 800; MaxX = 2000 }
    )) {
        $sideSegments = @($segments | Where-Object { (Get-AbsolutePosition $_ $Root)[0] -eq ((Get-AbsolutePosition $Main $Root)[0] + $side.X) })
        if ($sideSegments.Count -ne 5) {
            Add-CheckError "01-global.svg $($side.Name) segment count is not five"
            continue
        }
        foreach ($code in @('US', 'T1', 'T2', 'T3')) {
            $label = $children | Where-Object {
                $text = Get-TextLabel $_
                $position = Get-AbsolutePosition $_ $Root
                $text -match "^$code\s" -and $position[0] -ge ((Get-AbsolutePosition $Main $Root)[0] + $side.MinX) -and $position[0] -lt ((Get-AbsolutePosition $Main $Root)[0] + $side.MaxX)
            } | Select-Object -First 1
            if ($null -eq $label) {
                Add-CheckError "01-global.svg $($side.Name) label $code is missing"
                continue
            }
            $labelPosition = Get-AbsolutePosition $label $Root
            $segment = $sideSegments | Where-Object {
                $rect = $_.SelectSingleNode('./*[local-name()="rect"]')
                $color = switch ($code) {
                    'US' { '#5b5ce2' }
                    'T1' { '#20a7a0' }
                    'T2' { '#63bce3' }
                    'T3' { '#3867b9' }
                }
                $rect.GetAttribute('fill') -eq $color
            } | Select-Object -First 1
            $segmentPosition = Get-AbsolutePosition $segment $Root
            $rect = $segment.SelectSingleNode('./*[local-name()="rect"]')
            Assert-Approx $labelPosition[0] ($segmentPosition[0] + ([double]$rect.GetAttribute('width') / 2)) "01-global.svg $($side.Name) $code horizontal center"
            Assert-Approx $labelPosition[1] ($segmentPosition[1] + ([double]$rect.GetAttribute('height') / 2)) "01-global.svg $($side.Name) $code vertical center"
            if ((Get-TextNode $label).GetAttribute('font-weight') -eq 'bold') {
                Add-CheckError "01-global.svg $($side.Name) $code data is bold"
            }
        }

        $sideTitles = @($children | Where-Object {
            (Get-TextLabel $_) -eq $(if ($side.Name -eq 'download') { '下载侧' } else { '收入侧' })
        } | Sort-Object { (Get-AbsolutePosition $_ $Root)[1] })
        if ($sideTitles.Count -ne 2) {
            Add-CheckError "01-global.svg $($side.Name) must have upper and lower titles"
            continue
        }
        $top = ($sideSegments | ForEach-Object { (Get-AbsolutePosition $_ $Root)[1] } | Measure-Object -Minimum).Minimum
        $bottom = ($sideSegments | ForEach-Object {
            $position = Get-AbsolutePosition $_ $Root
            $rect = $_.SelectSingleNode('./*[local-name()="rect"]')
            $position[1] + [double]$rect.GetAttribute('height')
        } | Measure-Object -Maximum).Maximum
        $fontSize = [double](Get-TextNode $sideTitles[0]).GetAttribute('font-size')
        $topGap = $top - ((Get-AbsolutePosition $sideTitles[0] $Root)[1] + ($fontSize / 2))
        $bottomGap = ((Get-AbsolutePosition $sideTitles[1] $Root)[1] - ($fontSize / 2)) - $bottom
        Assert-Approx $topGap $bottomGap "01-global.svg $($side.Name) title-to-bar gaps"
    }
}

function Assert-NoteGeometry {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Root,
        [string]$FileName,
        [string]$NotePattern,
        [double]$ExpectedDividerWidth
    )

    $children = Get-ElementChildren $Main
    $note = $children | Where-Object { (Get-TextLabel $_) -match $NotePattern } | Select-Object -First 1
    if ($null -eq $note) {
        Add-CheckError "$FileName note is missing"
        return
    }

    $notePosition = Get-AbsolutePosition $note $Root
    $noteText = Get-TextNode $note
    $fontSize = [double]$noteText.GetAttribute('font-size')
    $divider = $children |
        Where-Object {
            $path = Get-PathNode $_
            $position = Get-AbsolutePosition $_ $Root
            $null -ne $path -and
            $position[1] -lt $notePosition[1] -and
            $position[1] -gt 800 -and
            $path.GetAttribute('d') -eq ([string]::Format($culture, 'M 0 0 L {0:0.####} 0', $ExpectedDividerWidth))
        } |
        Sort-Object { (Get-AbsolutePosition $_ $Root)[1] } -Descending |
        Select-Object -First 1
    if ($null -eq $divider) {
        Add-CheckError "$FileName note divider is missing"
    }
    else {
        $dividerY = (Get-AbsolutePosition $divider $Root)[1]
        Assert-Approx ($notePosition[1] - $dividerY) 18.0348 "$FileName divider-to-note gap"
    }
    Assert-Approx ($notePosition[1] + $fontSize) 932 "$FileName note bottom anchor"
}

function Assert-TrendLegendSpacing {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Root
    )

    $children = Get-ElementChildren $Main
    $legendDefinitions = @(
        @{ Stroke = '#2f67e8'; Label = '下载侧T3' },
        @{ Stroke = '#f05a00'; Label = '收入侧US+T1' },
        @{ Stroke = '#0f766e'; Label = '收入数据覆盖率' }
    )
    $legendItems = @()
    foreach ($definition in $legendDefinitions) {
        $line = $children | Where-Object {
            $path = Get-PathNode $_
            $null -ne $path -and
            $path.GetAttribute('stroke') -eq $definition.Stroke -and
            $path.GetAttribute('d') -eq 'M 0 0 L 28.08 0'
        } | Select-Object -First 1
        $text = $children | Where-Object { (Get-TextLabel $_) -eq $definition.Label } | Select-Object -First 1
        if ($null -eq $line -or $null -eq $text) {
            Add-CheckError "02-trend.svg legend item is missing for $($definition.Label)"
            continue
        }

        $legendItems += New-LegendItem @($line, $text) $Root
    }

    if ($legendItems.Count -lt 2) {
        return
    }

    $mainPosition = Get-AbsolutePosition $Main $Root
    Assert-LegendLayout $legendItems ($mainPosition[0] + [double]$contract.trend.legendCenterX) '02-trend.svg legend'
}

function Assert-TrendRows {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Root
    )

    $children = Get-ElementChildren $Main
    Assert-TrendLegendSpacing $Main $Root
    $note = $children |
        Where-Object { (Get-TextLabel $_) -match '^口径：' } |
        Select-Object -First 1
    if ($null -eq $note) {
        Add-CheckError '02-trend.svg note is missing for row check'
        return
    }

    $noteLabel = Get-TextLabel $note
    if ($noteLabel -notmatch '收入数据覆盖率表示.*收入国Top5信息.*应用×周.*覆盖率偏低.*方向性观察') {
        Add-CheckError '02-trend.svg note does not explain coverage rate'
    }

    $notePosition = Get-AbsolutePosition $note $Root
    $noteDivider = $children |
        Where-Object {
            $path = Get-PathNode $_
            $position = Get-AbsolutePosition $_ $Root
            $null -ne $path -and
            $position[1] -lt $notePosition[1] -and
            $path.GetAttribute('d') -eq 'M 0 0 L 1468.8 0'
        } |
        Sort-Object { (Get-AbsolutePosition $_ $Root)[1] } -Descending |
        Select-Object -First 1
    $plotBottom = $children |
        Where-Object {
            $path = Get-PathNode $_
            $position = Get-AbsolutePosition $_ $Root
            $null -ne $path -and
            $null -ne $noteDivider -and
            $position[1] -lt (Get-AbsolutePosition $noteDivider $Root)[1] -and
            $path.GetAttribute('d') -eq 'M 0 0 L 1296 0'
        } |
        Sort-Object { (Get-AbsolutePosition $_ $Root)[1] } -Descending |
        Select-Object -First 1
    if ($null -eq $noteDivider -or $null -eq $plotBottom) {
        Add-CheckError '02-trend.svg row boundary lines are missing'
        return
    }

    $dateLabels = @(
        $children |
            Where-Object { (Get-TextLabel $_) -match '^\d{2}/\d{2}$' } |
            Sort-Object { (Get-AbsolutePosition $_ $Root)[0] }
    )
    $endpointLabels = @(
        $children | Where-Object {
            $label = Get-TextLabel $_
            $label -match '^下载侧T3 \d' -or
            $label -match '^收入侧US\+T1 \d' -or
            $label -match '^收入数据覆盖率\d'
        }
    )
    if ($dateLabels.Count -eq 0 -or $endpointLabels.Count -ne 3) {
        Add-CheckError '02-trend.svg date or endpoint labels are missing'
        return
    }

    $plotBottomY = (Get-AbsolutePosition $plotBottom $Root)[1]
    $noteDividerY = (Get-AbsolutePosition $noteDivider $Root)[1]
    $dateCenter = $plotBottomY + (($noteDividerY - $plotBottomY) / 4)
    $dateFontSize = [double]::Parse(
        (Get-TextNode $dateLabels[0]).GetAttribute('font-size'),
        $culture
    )
    $endpointCenter = (($dateCenter + $noteDividerY) / 2) + ($dateFontSize / 4)

    $dateCenter = (Get-AbsolutePosition $dateLabels[0] $Root)[1]
    foreach ($dateLabel in $dateLabels) {
        $position = Get-AbsolutePosition $dateLabel $Root
        Assert-Approx $position[1] $dateCenter '02-trend date row equal center'
        $text = Get-TextNode $dateLabel
        if ($text.GetAttribute('dominant-baseline') -ne 'middle') {
            Add-CheckError '02-trend date labels are not vertically centered'
        }
    }
    Assert-Approx $dateCenter ($plotBottomY + (($noteDividerY - $plotBottomY) / 4)) '02-trend date row center'

    $endpointPatterns = @(
        '^下载侧T3 \d',
        '^收入侧US\+T1 \d',
        '^收入数据覆盖率\d'
    )
    $endpointCenter = $null
    for ($index = 0; $index -lt $endpointPatterns.Count; $index++) {
        $label = $endpointLabels | Where-Object { (Get-TextLabel $_) -match $endpointPatterns[$index] } | Select-Object -First 1
        if ($null -eq $label) {
            Add-CheckError "02-trend endpoint row $($index + 1) is missing"
            continue
        }
        $position = Get-AbsolutePosition $label $Root
        if ($null -eq $endpointCenter) {
            $endpointCenter = $position[1]
        }
        Assert-Approx $position[1] $endpointCenter "02-trend endpoint labels equal center"
        Assert-Approx $position[1] $endpointCenter "02-trend endpoint row center"
        $text = Get-TextNode $label
        if ($text.GetAttribute('dominant-baseline') -ne 'middle' -or $text.GetAttribute('text-anchor') -ne 'middle') {
            Add-CheckError "02-trend endpoint row $($index + 1) is not horizontally or vertically centered"
        }
    }

    $downloadEndpoint = $endpointLabels |
        Where-Object { (Get-TextLabel $_) -match '^下载侧T3 \d' } |
        Select-Object -First 1
    $endpointFontSize = [double]::Parse(
        (Get-TextNode $downloadEndpoint).GetAttribute('font-size'),
        $culture
    )
    $visibleDateToEndpointGap =
        $endpointCenter - ($endpointFontSize / 2) - ($dateCenter + ($dateFontSize / 2))
    $visibleEndpointToDividerGap =
        $noteDividerY - ($endpointCenter + ($endpointFontSize / 2))
    Assert-Approx $visibleDateToEndpointGap $visibleEndpointToDividerGap '02-trend visible vertical gaps'
}

function Assert-CategoryRows {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Root
    )

    $children = Get-ElementChildren $Main
    $legend = $children | Where-Object { (Get-TextLabel $_) -eq '下载T2+T3收入US+T1' } | Select-Object -First 1
    if ($null -eq $legend) {
        Add-CheckError '03-category.svg legend is missing'
    }
    else {
        $legendChildren = Get-ElementChildren $legend
        if ($legendChildren.Count -ne 4) {
            Add-CheckError '03-category.svg legend marker-text pairs are incomplete'
        }
        else {
            $legendItems = @(
                (New-LegendItem @($legendChildren[0], $legendChildren[1]) $Root)
                (New-LegendItem @($legendChildren[2], $legendChildren[3]) $Root)
            )
            $mainPosition = Get-AbsolutePosition $Main $Root
            Assert-LegendLayout $legendItems ($mainPosition[0] + [double]$contract.category.legendCenterX) '03-category.svg legend'
        }
    }
    $bars = @($children | Where-Object {
        $rect = $_.SelectSingleNode("./*[local-name()='rect']")
        $null -ne $rect -and $rect.GetAttribute('height') -eq '18.9' -and $rect.GetAttribute('fill') -in @('#3867b9', '#93c5fd')
    } | Sort-Object { (Get-AbsolutePosition $_ $Root)[1] })
    if ($bars.Count -ne 14) {
        Add-CheckError "03-category.svg does not contain 14 category bars"
        return
    }

    $expectedAxisWidth = [string]::Format($culture, '{0:0.####}', [double]$contract.category.barWidthAt100)
    $boundaries = @($children | Where-Object {
        $path = Get-PathNode $_
        $position = Get-AbsolutePosition $_ $Root
        $null -ne $path -and
        $_.GetAttribute('id') -ne 'category-bottom-boundary' -and
        $path.GetAttribute('d') -match "^M 0 0 L (?:1491|$([regex]::Escape($expectedAxisWidth))) 0$" -and
        $position[1] -ge 300 -and
        $position[1] -lt 850
    } | Sort-Object { (Get-AbsolutePosition $_ $Root)[1] })
    if ($boundaries.Count -ne 8) {
        Add-CheckError "03-category.svg does not contain eight row boundaries"
        return
    }

    $rowHeights = @()
    for ($index = 0; $index -lt 7; $index++) {
        $top = (Get-AbsolutePosition $boundaries[$index] $Root)[1]
        $bottom = (Get-AbsolutePosition $boundaries[$index + 1] $Root)[1]
        $rowHeights += ($bottom - $top)
    }
    foreach ($height in $rowHeights) {
        Assert-Approx $height $rowHeights[0] '03-category equal row height'
    }

    $bottomBoundary = $children | Where-Object { $_.GetAttribute('id') -eq 'category-bottom-boundary' } | Select-Object -First 1
    if ($null -eq $bottomBoundary) {
        Add-CheckError '03-category bottom boundary is missing'
    }
    else {
        Assert-Approx ((Get-AbsolutePosition $bottomBoundary $Root)[1]) ((Get-AbsolutePosition $boundaries[-1] $Root)[1]) '03-category bottom boundary Y'
    }

    $categoryLabels = @(
        '品类',
        'Launcher',
        'PDF阅读器',
        '休闲',
        '壁纸',
        '文件恢复',
        '杀毒软件、清理',
        '超休闲'
    )
    $mainPosition = Get-AbsolutePosition $Main $Root
    $expectedCategoryX = $mainPosition[0] + [double]$contract.category.categoryCenterX
    $expectedCoverageX = $mainPosition[0] + [double]$contract.category.coverageCenterX

    foreach ($node in @($children | Where-Object { $categoryLabels -contains (Get-TextLabel $_) })) {
        $position = Get-AbsolutePosition $node $Root
        Assert-Approx $position[0] $expectedCategoryX '03-category category column center'
        $text = Get-TextNode $node
        if ($text.GetAttribute('text-anchor') -ne 'middle') {
            Add-CheckError '03-category category labels are not horizontally centered'
        }
    }

    $categoryNodes = @(
        $children |
            Where-Object { $categoryLabels -contains (Get-TextLabel $_) -and (Get-TextLabel $_) -ne '品类' } |
            Sort-Object { (Get-AbsolutePosition $_ $Root)[1] }
    )
    for ($index = 0; $index -lt $categoryNodes.Count; $index++) {
        $expectedY = ((Get-AbsolutePosition $boundaries[$index] $Root)[1] + (Get-AbsolutePosition $boundaries[$index + 1] $Root)[1]) / 2
        Assert-Approx (Get-AbsolutePosition $categoryNodes[$index] $Root)[1] $expectedY '03-category category row center'
    }

    $coverageNodes = @($children | Where-Object {
        $label = Get-TextLabel $_
        $position = Get-AbsolutePosition $_ $Root
        $label -match '^\d+(?:\.\d+)?%$' -and
        $position[0] -gt ($mainPosition[0] + 1200) -and
        $position[1] -gt 300 -and
        $position[1] -lt 800
    })
    if ($coverageNodes.Count -ne 7) {
        Add-CheckError '03-category coverage values are missing'
    }
    foreach ($node in $coverageNodes) {
        $position = Get-AbsolutePosition $node $Root
        Assert-Approx $position[0] $expectedCoverageX '03-category coverage column center'
        $text = Get-TextNode $node
        if ($text.GetAttribute('text-anchor') -ne 'middle') {
            Add-CheckError '03-category coverage values are not horizontally centered'
        }
    }
    for ($index = 0; $index -lt $coverageNodes.Count; $index++) {
        $expectedY = ((Get-AbsolutePosition $boundaries[$index] $Root)[1] + (Get-AbsolutePosition $boundaries[$index + 1] $Root)[1]) / 2
        Assert-Approx (Get-AbsolutePosition $coverageNodes[$index] $Root)[1] $expectedY '03-category coverage row center'
    }

    $coverageHeader = $children | Where-Object { (Get-TextLabel $_) -eq '收入覆盖率' } | Select-Object -First 1
    if ($null -eq $coverageHeader) {
        Add-CheckError '03-category coverage header is missing'
    }
    else {
        Assert-Approx ((Get-AbsolutePosition $coverageHeader $Root)[0]) $expectedCoverageX '03-category coverage header center'
        if ((Get-TextNode $coverageHeader).GetAttribute('text-anchor') -ne 'middle') {
            Add-CheckError '03-category coverage header is not horizontally centered'
        }
    }
}

function Assert-RegionRows {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$Root
    )

    $children = Get-ElementChildren $Main
    $legendItems = @()
    foreach ($definition in @(
        @{ Fill = '#2f67e8'; Label = '下载侧' },
        @{ Fill = '#f05a00'; Label = '收入侧' }
    )) {
        $marker = $children | Where-Object {
            $shape = $_.SelectSingleNode('./*[local-name()="ellipse" or local-name()="circle"]')
            $null -ne $shape -and $shape.GetAttribute('fill') -eq $definition.Fill
        } | Select-Object -First 1
        $text = $children | Where-Object { (Get-TextLabel $_) -eq $definition.Label } | Select-Object -First 1
        if ($null -eq $marker -or $null -eq $text) {
            Add-CheckError "05-regions.svg legend item is missing for $($definition.Label)"
            continue
        }
        $legendItems += New-LegendItem @($marker, $text) $Root
    }
    if ($legendItems.Count -eq 2) {
        $mainPosition = Get-AbsolutePosition $Main $Root
        Assert-LegendLayout $legendItems ($mainPosition[0] + [double]$contract.regions.legendCenterX) '05-regions.svg legend'
    }
    $downloadBars = @($children | Where-Object {
        $rect = $_.SelectSingleNode("./*[local-name()='rect']")
        $null -ne $rect -and $rect.GetAttribute('fill') -eq '#2f67e8' -and $rect.GetAttribute('height') -eq '48.4'
    } | Sort-Object { (Get-AbsolutePosition $_ $Root)[1] })
    $incomeBars = @($children | Where-Object {
        $rect = $_.SelectSingleNode("./*[local-name()='rect']")
        $null -ne $rect -and $rect.GetAttribute('fill') -eq '#f05a00' -and $rect.GetAttribute('height') -eq '48.4'
    } | Sort-Object { (Get-AbsolutePosition $_ $Root)[1] })
    if ($downloadBars.Count -ne 4 -or $incomeBars.Count -ne 4) {
        Add-CheckError '05-regions.svg does not contain four bars per side'
        return
    }

    $centers = @()
    foreach ($bar in $downloadBars) {
        $position = Get-AbsolutePosition $bar $Root
        $rect = $bar.SelectSingleNode("./*[local-name()='rect']")
        $centers += $position[1] + ([double]$rect.GetAttribute('height') / 2)
    }
    $step = ($centers[-1] - $centers[0]) / 3
    for ($index = 1; $index -lt 4; $index++) {
        Assert-Approx ($centers[$index] - $centers[$index - 1]) $step '05-regions equal row spacing'
    }

    $noteDivider = $children | Where-Object { $_.GetAttribute('id') -eq 'region-note-divider' } | Select-Object -First 1
    if ($null -eq $noteDivider) {
        Add-CheckError '05-regions note divider is missing'
    }
    else {
        $dividerY = (Get-AbsolutePosition $noteDivider $Root)[1]
        Assert-Approx ($centers[-1] + ($step / 2)) $dividerY '05-regions last row to note divider alignment'
    }

    foreach ($node in @($children | Where-Object { (Get-TextLabel $_) -in @('US', 'IN', '拉美', '东南亚') })) {
        $text = Get-TextNode $node
        if ($text.GetAttribute('text-anchor') -ne 'middle' -or $text.GetAttribute('dominant-baseline') -ne 'middle') {
            Add-CheckError '05-regions names are not centered'
        }
        Assert-Approx (Get-AbsolutePosition $node $Root)[0] ((Get-AbsolutePosition $Main $Root)[0] + 770) '05-regions name column center'
    }

    $downloadLabels = @($children | Where-Object {
        $text = Get-TextNode $_
        (Get-TextLabel $_) -match '^\d+(?:\.\d+)?%$' -and
        $null -ne $text -and $text.GetAttribute('fill') -eq '#ffffff' -and
        (Get-AbsolutePosition $_ $Root)[0] -lt ((Get-AbsolutePosition $Main $Root)[0] + 800)
    } | Sort-Object { (Get-AbsolutePosition $_ $Root)[1] })
    $incomeLabels = @($children | Where-Object {
        $text = Get-TextNode $_
        (Get-TextLabel $_) -match '^\d+(?:\.\d+)?%$' -and
        $null -ne $text -and $text.GetAttribute('fill') -eq '#ffffff' -and
        (Get-AbsolutePosition $_ $Root)[0] -ge ((Get-AbsolutePosition $Main $Root)[0] + 800)
    } | Sort-Object { (Get-AbsolutePosition $_ $Root)[1] })
    for ($index = 0; $index -lt 4; $index++) {
        $downloadPosition = Get-AbsolutePosition $downloadBars[$index] $Root
        $downloadRect = $downloadBars[$index].SelectSingleNode('./*[local-name()="rect"]')
        $incomePosition = Get-AbsolutePosition $incomeBars[$index] $Root
        Assert-Approx (Get-AbsolutePosition $downloadLabels[$index] $Root)[0] ($downloadPosition[0] + [double]$downloadRect.GetAttribute('width') - 17) '05-regions download label inset'
        Assert-Approx (Get-AbsolutePosition $incomeLabels[$index] $Root)[0] ($incomePosition[0] + 17) '05-regions income label inset'
    }
}

foreach ($fileName in $expectedFiles) {
    $path = Join-Path $InputDir $fileName
    if (-not (Test-Path -LiteralPath $path)) {
        Add-CheckError "Missing $fileName"
        continue
    }

    [xml]$svg = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    $root = $svg.DocumentElement
    if ($root.GetAttribute('width') -ne '1640' -or $root.GetAttribute('height') -ne '1020' -or $root.GetAttribute('viewBox') -ne '-20 -20 1640 1020') {
        Add-CheckError "$fileName root canvas is not fixed"
    }
    $background = $root.SelectSingleNode("./*[local-name()='g'][1]/*[local-name()='rect']")
    if ($null -eq $background -or $background.GetAttribute('width') -ne '1600' -or $background.GetAttribute('height') -ne '980') {
        Add-CheckError "$fileName white canvas is not 1600x980"
    }

    $groups = Get-ElementChildren $root
    if ($groups.Count -lt 2) {
        Add-CheckError "$fileName main group is missing"
        continue
    }
    $main = $groups[1]
    Assert-Header $main $root $fileName
    Assert-TopContentAnchor $main $root $fileName
    Assert-TextRules $main $fileName

    switch ($fileName) {
        '01-global.svg' {
            Assert-GlobalChart $main $root
        }
        '02-trend.svg' {
            Assert-NoteGeometry $main $root $fileName '^口径：' 1468.8
            Assert-TrendRows $main $root
        }
        '03-category.svg' {
            Assert-CategoryRows $main $root
            Assert-NoteGeometry $main $root $fileName '^同一品类中' 1491
        }
        '04-countries.svg' {
            Assert-CategoryCountryRows $main $root
        }
        '05-regions.svg' {
            Assert-RegionRows $main $root
            Assert-NoteGeometry $main $root $fileName '^IN、拉美、东南亚' 1491
        }
    }
}

if ($errors.Count -gt 0) {
    Write-Output 'CHART_LAYOUT_CHECK: FAIL'
    $errors | ForEach-Object { Write-Output ("- $_") }
    exit 1
}

Write-Output 'CHART_LAYOUT_CHECK: PASS'
