[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DataPath,

    [string]$OutputDir = '',

    [string]$TemplateDir = ''
)

$ErrorActionPreference = 'Stop'
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$scriptRoot = $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $projectDir = $env:AMDA_PROJECT_DIR
    if ([string]::IsNullOrWhiteSpace($projectDir)) {
        $projectDir = Split-Path -Parent $scriptRoot
    }
    $OutputDir = Join-Path $projectDir 'output\charts'
}

if ([string]::IsNullOrWhiteSpace($TemplateDir)) {
    $TemplateDir = Join-Path $scriptRoot '..\templates'
}

$contractPath = Join-Path $scriptRoot '..\references\chart-layout-contract.json'
$contract = Get-Content -LiteralPath $contractPath -Raw -Encoding UTF8 | ConvertFrom-Json
$data = Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Get-ElementChildren {
    param([System.Xml.XmlNode]$Node)

    return @($Node.ChildNodes | Where-Object { $_.NodeType -eq 'Element' })
}

function Get-MainGroup {
    param([System.Xml.XmlDocument]$Svg)

    $groups = Get-ElementChildren $Svg.DocumentElement
    if ($groups.Count -lt 2) {
        throw 'SVG does not contain the expected background and content groups'
    }
    return $groups[1]
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

    $Node.SetAttribute(
        'transform',
        [string]::Format($culture, 'translate({0:0.####}, {1:0.####})', $X, $Y)
    )
}

function Get-DirectPath {
    param([System.Xml.XmlElement]$Node)

    return $Node.SelectSingleNode('./*[local-name()="path"]')
}

function Get-DirectRect {
    param([System.Xml.XmlElement]$Node)

    return $Node.SelectSingleNode('./*[local-name()="rect"]')
}

function Get-DirectText {
    param([System.Xml.XmlElement]$Node)

    return $Node.SelectSingleNode('./*[local-name()="text"]')
}

function Get-LeafText {
    param([System.Xml.XmlElement]$Node)

    $leaf = $Node.SelectSingleNode(".//*[local-name()='tspan'][not(*)]")
    if ($null -ne $leaf) {
        return $leaf.InnerText
    }
    $text = $Node.SelectSingleNode('.//*[local-name()="text"]')
    if ($null -ne $text) {
        return $text.InnerText
    }
    return ''
}

function Get-EstimatedTextWidth {
    param([System.Xml.XmlElement]$Node)

    $textNode = $Node.SelectSingleNode('.//*[local-name()="text"]')
    if ($null -eq $textNode) {
        throw "Text node not found on $($Node.GetAttribute('id'))"
    }
    $fontSize = [double]$textNode.GetAttribute('font-size')
    $width = 0.0
    foreach ($character in (Get-LeafText $Node).ToCharArray()) {
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
    param([System.Xml.XmlElement]$Node)

    $position = Get-Translate $Node
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
    param([System.Xml.XmlElement[]]$Nodes)

    $parts = @()
    foreach ($node in @($Nodes)) {
        $position = Get-Translate $node
        $bounds = Get-NodeHorizontalBounds $node
        $parts += [pscustomobject]@{
            Node = $node
            X = $position[0]
            Y = $position[1]
            Left = $bounds.Left
            Right = $bounds.Right
        }
    }
    if ($parts.Count -eq 0) {
        throw 'Legend item must contain at least one element'
    }

    $baseX = ($parts | Measure-Object -Property Left -Minimum).Minimum
    $right = ($parts | Measure-Object -Property Right -Maximum).Maximum
    return [pscustomobject]@{
        Parts = @($parts | ForEach-Object {
            [pscustomobject]@{
                Node = $_.Node
                OffsetX = $_.X - $baseX
                Y = $_.Y
            }
        })
        LeftX = $baseX
        RightX = $right
        ItemWidth = $right - $baseX
    }
}

function Set-LegendItemsCenter {
    param(
        [object[]]$Items,
        [double]$CenterX
    )

    if (@($Items).Count -eq 0) {
        throw 'Legend items are required for horizontal layout'
    }
    $gap = [double]$contract.spacing.minimumElementGap
    $totalWidth = (($Items | ForEach-Object { [double]$_.ItemWidth } | Measure-Object -Sum).Sum) + ($gap * (@($Items).Count - 1))
    $cursor = $CenterX - ($totalWidth / 2)
    foreach ($item in @($Items)) {
        foreach ($part in @($item.Parts)) {
            Set-Translate $part.Node ($cursor + $part.OffsetX) $part.Y
        }
        $cursor += [double]$item.ItemWidth + $gap
    }
}

function Set-NestedLegendCenter {
    param(
        [System.Xml.XmlElement]$Container,
        [object[]]$Items,
        [double]$CenterX
    )

    $left = ($Items | Measure-Object -Property LeftX -Minimum).Minimum
    $right = ($Items | Measure-Object -Property RightX -Maximum).Maximum
    $internalCenter = ($left + $right) / 2
    Set-LegendItemsCenter $Items $internalCenter
    $containerPosition = Get-Translate $Container
    Set-Translate $Container ($CenterX - $internalCenter) $containerPosition[1]
}

function Set-LeafText {
    param(
        [System.Xml.XmlElement]$Node,
        [string]$Value
    )

    $leaf = $Node.SelectSingleNode(".//*[local-name()='tspan'][not(*)]")
    if ($null -ne $leaf) {
        $leaf.InnerText = $Value
        return
    }
    $text = $Node.SelectSingleNode('.//*[local-name()="text"]')
    if ($null -eq $text) {
        throw "Text node not found on $($Node.GetAttribute('id'))"
    }
    $text.InnerText = $Value
}

function Set-TextHorizontalAlignment {
    param(
        [System.Xml.XmlElement]$Node,
        [ValidateSet('start', 'middle', 'end')]
        [string]$Anchor
    )

    $text = $Node.SelectSingleNode('.//*[local-name()="text"]')
    if ($null -eq $text) {
        throw "Text node not found on $($Node.GetAttribute('id'))"
    }
    $text.SetAttribute('x', '0')
    $text.SetAttribute('text-anchor', $Anchor)
    foreach ($tspan in $text.SelectNodes('.//*[local-name()="tspan"]')) {
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
    $text = $Node.SelectSingleNode('.//*[local-name()="text"]')
    if ($null -eq $text) {
        throw "Text node not found on $($Node.GetAttribute('id'))"
    }
    $text.SetAttribute('y', '0')
    $text.SetAttribute('dominant-baseline', 'middle')
    Set-TextHorizontalAlignment $Node 'middle'
    foreach ($tspan in $text.SelectNodes('.//*[local-name()="tspan"]')) {
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
    $text = $Node.SelectSingleNode('.//*[local-name()="text"]')
    if ($null -eq $text) {
        throw "Text node not found on $($Node.GetAttribute('id'))"
    }
    $text.SetAttribute('y', '0')
    $text.SetAttribute('dominant-baseline', 'middle')
    foreach ($tspan in $text.SelectNodes('.//*[local-name()="tspan"]')) {
        $tspan.SetAttribute('y', '0')
    }
}

function Format-Percent {
    param([double]$Value)

    return [string]::Format($culture, '{0:0.0}%', $Value)
}

function Assert-Percent {
    param(
        [double]$Value,
        [string]$Label
    )

    if ($Value -lt 0 -or $Value -gt 100) {
        throw "$Label must be between 0 and 100, got $Value"
    }
}

function Get-DataNumber {
    param(
        [object]$Object,
        [string]$Property,
        [string]$Label
    )

    $propertyValue = $Object.PSObject.Properties[$Property]
    if ($null -eq $propertyValue) {
        throw "Missing data field $Label"
    }
    $value = [double]$propertyValue.Value
    Assert-Percent $value $Label
    return $value
}

function New-PathData {
    param(
        [double[]]$Values,
        [double]$PlotWidth,
        [double]$PlotHeight,
        [double]$AxisMin,
        [double]$AxisMax
    )

    if ($Values.Count -lt 2) {
        throw 'Trend series must contain at least two points'
    }
    $parts = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $Values.Count; $index++) {
        $x = $PlotWidth * $index / ($Values.Count - 1)
        $y = $PlotHeight * ($AxisMax - $Values[$index]) / ($AxisMax - $AxisMin)
        $command = if ($index -eq 0) { 'M' } else { 'L' }
        [void]$parts.Add([string]::Format($culture, '{0} {1:0.####} {2:0.####}', $command, $x, $y))
    }
    return ($parts -join ' ')
}

function New-Id {
    param([string]$Prefix, [int]$Index)

    return "renderer-$Prefix-$Index"
}

function Update-GlobalChart {
    param(
        [System.Xml.XmlDocument]$Svg,
        [object]$ChartData
    )

    $main = Get-MainGroup $Svg
    $children = Get-ElementChildren $main
    $legend = $children | Where-Object { $_.InnerText.Trim() -eq 'UST1T2T3其他' } | Select-Object -First 1
    if ($null -eq $legend) {
        throw 'Global legend not found'
    }
    $legendChildren = Get-ElementChildren $legend
    if ($legendChildren.Count -ne 10) {
        throw 'Global legend must contain five marker-text pairs'
    }
    $legendItems = @()
    for ($index = 0; $index -lt 5; $index++) {
        $legendItems += New-LegendItem @(
            $legendChildren[$index * 2],
            $legendChildren[($index * 2) + 1]
        )
    }
    Set-NestedLegendCenter $legend $legendItems ([double]$contract.global.legendCenterX)
    $fills = @{
        US = '#5b5ce2'
        T1 = '#20a7a0'
        T2 = '#63bce3'
        T3 = '#3867b9'
        other = '#cbd5e1'
    }
    $order = @('T3', 'T2', 'T1', 'US', 'other')
    $barGroups = @(
        $children | Where-Object {
            $rect = Get-DirectRect $_
            $null -ne $rect -and $rect.GetAttribute('width') -eq '220' -and $fills.Values -contains $rect.GetAttribute('fill')
        }
    )
    if ($barGroups.Count -ne 10) {
        throw "Global template must contain 10 segment groups, found $($barGroups.Count)"
    }

    foreach ($sideName in @('download', 'income')) {
        $sideX = if ($sideName -eq 'download') { 352 } else { 968 }
        $sideGroups = @($barGroups | Where-Object { (Get-Translate $_)[0] -eq $sideX })
        if ($sideGroups.Count -ne 5) {
            throw "Global $sideName template must contain five segments"
        }
        $values = $ChartData.PSObject.Properties[$sideName].Value
        $sum = 0.0
        foreach ($code in @('US', 'T1', 'T2', 'T3', 'other')) {
            $sum += Get-DataNumber $values $code "global.$sideName.$code"
        }
        if ([math]::Abs($sum - 100) -gt 0.2) {
            throw "global.$sideName must sum to 100, got $sum"
        }

        $base = ($sideGroups | ForEach-Object {
            $position = Get-Translate $_
            $rect = Get-DirectRect $_
            $position[1] + [double]$rect.GetAttribute('height')
        } | Measure-Object -Maximum).Maximum
        $top = ($sideGroups | ForEach-Object { (Get-Translate $_)[1] } | Measure-Object -Minimum).Minimum
        $barHeight = $base - $top
        $cursor = $base
        $segmentCenters = @{}
        foreach ($code in $order) {
            $fill = $fills[$code]
            $group = $sideGroups | Where-Object { (Get-DirectRect $_).GetAttribute('fill') -eq $fill } | Select-Object -First 1
            $value = Get-DataNumber $values $code "global.$sideName.$code"
            $height = $barHeight * $value / 100
            $cursor -= $height
            $position = Get-Translate $group
            Set-Translate $group $position[0] $cursor
            $rect = Get-DirectRect $group
            $rect.SetAttribute('height', [string]::Format($culture, '{0:0.####}', $height))
            $segmentCenters[$code] = @(([double]$position[0] + 110), ($cursor + ($height / 2)))
        }

        foreach ($code in @('US', 'T1', 'T2', 'T3')) {
            $label = $children | Where-Object { (Get-LeafText $_) -match "^$code\s" -and (Get-Translate $_)[0] -lt 800 -eq ($sideName -eq 'download') } | Select-Object -First 1
            if ($null -eq $label) {
                $label = $children | Where-Object { (Get-LeafText $_) -match "^$code\s" -and (Get-Translate $_)[0] -ge 800 -eq ($sideName -eq 'income') } | Select-Object -First 1
            }
            if ($null -eq $label) {
                throw "Global $sideName label for $code not found"
            }
            Set-LeafText $label "$code $(Format-Percent (Get-DataNumber $values $code "global.$sideName.$code"))"
            Set-TextCenter $label $segmentCenters[$code][0] $segmentCenters[$code][1]
            $label.SelectSingleNode('.//*[local-name()="text"]').SetAttribute('font-weight', 'normal')
        }

        $otherLabel = $children | Where-Object { (Get-LeafText $_) -match '^其他' -and ((Get-Translate $_)[0] -lt 800) -eq ($sideName -eq 'download') } | Select-Object -First 1
        $leader = $children | Where-Object {
            $path = Get-DirectPath $_
            $null -ne $path -and $path.GetAttribute('d') -eq 'M 0 0 L 22 0' -and (((Get-Translate $_)[0] -lt 800) -eq ($sideName -eq 'download'))
        } | Select-Object -First 1
        if ($null -eq $otherLabel -or $null -eq $leader) {
            throw "Global $sideName other label or leader not found"
        }
        $otherGroup = $sideGroups | Where-Object { (Get-DirectRect $_).GetAttribute('fill') -eq $fills.other } | Select-Object -First 1
        $otherPosition = Get-Translate $otherGroup
        $otherValue = Get-DataNumber $values 'other' "global.$sideName.other"
        Set-LeafText $otherLabel "其他$(Format-Percent $otherValue)"
        Set-Translate $leader ($sideX + 220) $top
        Set-Translate $otherLabel ($sideX + 253) $top
        Set-TextVerticalCenter $otherLabel $top
    }
}

function Update-TrendChart {
    param(
        [System.Xml.XmlDocument]$Svg,
        [object]$ChartData
    )

    $main = Get-MainGroup $Svg
    $children = Get-ElementChildren $main
    $dates = @($ChartData.dates | ForEach-Object { [string]$_ })
    if ($dates.Count -lt 2) {
        throw 'trend.dates must contain at least two dates'
    }
    $series = @(
        @{ Key = 'downloadT3'; Stroke = '#2f67e8'; Label = '下载侧T3' },
        @{ Key = 'incomeUSPlusT1'; Stroke = '#f05a00'; Label = '收入侧US+T1' },
        @{ Key = 'coverage'; Stroke = '#0f766e'; Label = '收入数据覆盖率' }
    )
    $legendItems = @()
    foreach ($item in $series) {
        $legendLine = $children | Where-Object {
            $path = Get-DirectPath $_
            $null -ne $path -and
            $path.GetAttribute('stroke') -eq $item.Stroke -and
            $path.GetAttribute('d') -eq 'M 0 0 L 28.08 0'
        } | Select-Object -First 1
        $legendText = $children | Where-Object { (Get-LeafText $_) -eq $item.Label } | Select-Object -First 1
        $legendMarker = $children | Where-Object {
            $shape = $_.SelectSingleNode('./*[local-name()="ellipse" or local-name()="circle"]')
            $position = Get-Translate $_
            $null -ne $shape -and
            $shape.GetAttribute('stroke') -eq $item.Stroke -and
            $position[1] -gt 210 -and
            $position[1] -lt 240
        } | Select-Object -First 1
        if ($null -eq $legendLine -or $null -eq $legendText -or $null -eq $legendMarker) {
            throw "Trend legend item not found for $($item.Label)"
        }
        $legendItems += New-LegendItem @($legendLine, $legendMarker, $legendText)
    }
    Set-LegendItemsCenter $legendItems ([double]$contract.trend.legendCenterX)
    $plotX = [double]$contract.trend.plotX
    $plotTop = [double]$contract.trend.plotTop
    $plotWidth = [double]$contract.trend.plotWidth
    $plotHeight = [double]$contract.trend.plotHeight
    $axisMin = [double]$contract.trend.axisMin
    $axisMax = [double]$contract.trend.axisMax

    $subtitle = $children[1]
    Set-LeafText $subtitle ([string]$ChartData.subtitle)

    foreach ($item in $series) {
        $values = @($ChartData.PSObject.Properties[$item.Key].Value | ForEach-Object { [double]$_ })
        if ($values.Count -ne $dates.Count) {
            throw "trend.$($item.Key) length must match trend.dates"
        }
        foreach ($value in $values) {
            if ($value -lt $axisMin -or $value -gt $axisMax) {
                throw "trend.$($item.Key) value $value is outside the fixed axis $axisMin-$axisMax"
            }
        }
        $line = @(
            $children | Where-Object {
                $path = Get-DirectPath $_
                $null -ne $path -and $path.GetAttribute('stroke') -eq $item.Stroke -and $path.GetAttribute('d').Length -gt 100
            }
        ) | Select-Object -First 1
        if ($null -eq $line) {
            throw "Trend line not found for $($item.Key)"
        }
        Set-Translate $line $plotX $plotTop
        (Get-DirectPath $line).SetAttribute('d', (New-PathData $values $plotWidth $plotHeight $axisMin $axisMax))

        $lastY = $plotHeight * ($axisMax - $values[-1]) / ($axisMax - $axisMin)
        $endpoint = @(
            $children | Where-Object {
                $ellipse = $_.SelectSingleNode('./*[local-name()="ellipse" or local-name()="circle"]')
                $null -ne $ellipse -and
                $ellipse.GetAttribute('stroke') -eq $item.Stroke -and
                $ellipse.GetAttribute('stroke-width') -eq '2.2'
            }
        ) | Select-Object -First 1
        if ($null -eq $endpoint) {
            throw "Trend endpoint marker not found for $($item.Key)"
        }
        Set-Translate $endpoint ($plotX + $plotWidth - 5.184) ($plotTop + $lastY - 5.184)
    }

    $dateTemplate = @($children | Where-Object { (Get-LeafText $_) -match '^\d{2}/\d{2}$' }) | Select-Object -First 1
    $tickTemplate = @($children | Where-Object { $path = Get-DirectPath $_; $null -ne $path -and $path.GetAttribute('d') -eq 'M 0 0 L 0 6.48' }) | Select-Object -First 1
    if ($null -eq $dateTemplate -or $null -eq $tickTemplate) {
        throw 'Trend date or tick template not found'
    }
    $oldDates = @($children | Where-Object { (Get-LeafText $_) -match '^\d{2}/\d{2}$' })
    $oldTicks = @($children | Where-Object { $path = Get-DirectPath $_; $null -ne $path -and $path.GetAttribute('d') -eq 'M 0 0 L 0 6.48' })
    foreach ($node in @($oldDates + $oldTicks)) {
        [void]$main.RemoveChild($node)
    }
    # Keep the formal report cadence: at most eight labels, always including
    # the first and last week. Floor-distributed indices preserve the approved
    # 23-week sequence 0,3,6,9,12,15,18,22.
    $labelCount = [Math]::Min(8, $dates.Count)
    $indices = [System.Collections.Generic.List[int]]::new()
    for ($orderIndex = 0; $orderIndex -lt $labelCount; $orderIndex++) {
        $rawIndex = $orderIndex * ($dates.Count - 1) / ($labelCount - 1)
        $index = [int][Math]::Floor($rawIndex)
        if ($indices.Count -eq 0 -or $indices[-1] -ne $index) {
            [void]$indices.Add($index)
        }
    }
    for ($orderIndex = 0; $orderIndex -lt $indices.Count; $orderIndex++) {
        $index = $indices[$orderIndex]
        $x = $plotX + ($plotWidth * $index / ($dates.Count - 1))
        $dateNode = $dateTemplate.CloneNode($true)
        $dateNode.SetAttribute('id', (New-Id 'date' $orderIndex))
        Set-LeafText $dateNode $dates[$index]
        Set-TextCenter $dateNode $x 0
        [void]$main.AppendChild($dateNode)

        $tickNode = $tickTemplate.CloneNode($true)
        $tickNode.SetAttribute('id', (New-Id 'tick' $orderIndex))
        Set-Translate $tickNode $x ($plotTop + $plotHeight)
        [void]$main.AppendChild($tickNode)
    }

    $endpointLabels = @(
        $children | Where-Object {
            (Get-LeafText $_) -match '^下载侧T3 ' -or
            (Get-LeafText $_) -match '^收入侧US\+T1 ' -or
            (Get-LeafText $_) -match '^收入数据覆盖率\d'
        }
    )
    if ($endpointLabels.Count -ne 3) {
        throw "Trend template must contain three endpoint labels"
    }
    $endpointPlans = @(
        @{ Label = '下载侧T3'; Key = 'downloadT3'; X = 350 },
        @{ Label = '收入侧US+T1'; Key = 'incomeUSPlusT1'; X = 800 },
        @{ Label = '收入数据覆盖率'; Key = 'coverage'; X = 1250 }
    )
    foreach ($plan in $endpointPlans) {
        $node = $endpointLabels | Where-Object { (Get-LeafText $_) -match "^$([regex]::Escape($plan.Label))" } | Select-Object -First 1
        $values = @($ChartData.PSObject.Properties[$plan.Key].Value | ForEach-Object { [double]$_ })
        $endpointText = if ($plan.Key -eq 'coverage') {
            "$($plan.Label)$(Format-Percent $values[-1])"
        }
        else {
            "$($plan.Label) $(Format-Percent $values[-1])"
        }
        Set-LeafText $node $endpointText
        Set-TextCenter $node $plan.X 0
    }
}

function Update-CategoryChart {
    param(
        [System.Xml.XmlDocument]$Svg,
        [object]$ChartData
    )

    $main = Get-MainGroup $Svg
    $children = Get-ElementChildren $main
    $legend = $children | Where-Object { $_.InnerText.Trim() -eq '下载T2+T3收入US+T1' } | Select-Object -First 1
    if ($null -eq $legend) {
        throw 'Category legend not found'
    }
    $legendChildren = Get-ElementChildren $legend
    if ($legendChildren.Count -ne 4) {
        throw 'Category legend must contain two marker-text pairs'
    }
    $legendItems = @(
        (New-LegendItem @($legendChildren[0], $legendChildren[1]))
        (New-LegendItem @($legendChildren[2], $legendChildren[3]))
    )
    Set-NestedLegendCenter $legend $legendItems ([double]$contract.category.legendCenterX)
    $rows = @($ChartData.rows)
    if ($rows.Count -ne [int]$contract.category.rowCount) {
        throw "category.rows must contain $($contract.category.rowCount) rows"
    }
    $boundaries = @(
        $children | Where-Object {
            $path = Get-DirectPath $_
            $null -ne $path -and
            $path.GetAttribute('d') -eq 'M 0 0 L 1491 0' -and
            (Get-Translate $_)[1] -ge 300 -and
            (Get-Translate $_)[1] -lt 850
        } | Sort-Object { (Get-Translate $_)[1] }
    )
    if ($boundaries.Count -ne 8) {
        throw "Category template must contain eight row boundaries"
    }

    $plotStartX = [double]$contract.category.barStartX
    $plotWidth = [double]$contract.category.barWidthAt100
    $plotTicks = @(
        for ($index = 0; $index -le 4; $index++) {
            $plotStartX + ($plotWidth * $index / 4)
        }
    )
    $gridLines = @(
        $children | Where-Object {
            $path = Get-DirectPath $_
            $position = Get-Translate $_
            $null -ne $path -and
            $path.GetAttribute('d') -eq 'M 0 0 L 0 466.2' -and
            $position[1] -gt 320 -and
            $position[1] -lt 335
        } | Sort-Object { (Get-Translate $_)[0] }
    )
    $axisTicks = @(
        $children | Where-Object {
            $path = Get-DirectPath $_
            $position = Get-Translate $_
            $null -ne $path -and
            $path.GetAttribute('d') -eq 'M 0 0 L 0 8.4' -and
            $position[1] -gt 785 -and
            $position[1] -lt 800
        } | Sort-Object { (Get-Translate $_)[0] }
    )
    if ($gridLines.Count -ne 5 -or $axisTicks.Count -ne 5) {
        throw 'Category template must contain five plot grid lines and five axis ticks'
    }
    for ($index = 0; $index -lt 5; $index++) {
        $gridPosition = Get-Translate $gridLines[$index]
        Set-Translate $gridLines[$index] $plotTicks[$index] $gridPosition[1]
        $tickPosition = Get-Translate $axisTicks[$index]
        Set-Translate $axisTicks[$index] $plotTicks[$index] $tickPosition[1]
    }
    $axis = $children | Where-Object {
        $path = Get-DirectPath $_
        $position = Get-Translate $_
        $null -ne $path -and
        $path.GetAttribute('d') -match '^M 0 0 L [0-9.]+ 0$' -and
        $position[1] -gt 785 -and
        $position[1] -lt 800
    } | Select-Object -First 1
    if ($null -eq $axis) {
        throw 'Category template plot axis is missing'
    }
    $axisPosition = Get-Translate $axis
    Set-Translate $axis $plotStartX $axisPosition[1]
    (Get-DirectPath $axis).SetAttribute('d', [string]::Format($culture, 'M 0 0 L {0:0.####} 0', $plotWidth))

    $tickOffsets = @(-10.8465, -14.9257, -14.9257, -14.9257, -19.005)
    $tickLabels = @('0%', '25%', '50%', '75%', '100%')
    for ($index = 0; $index -lt $tickLabels.Count; $index++) {
        $tickLabel = $children | Where-Object { (Get-LeafText $_) -eq $tickLabels[$index] } | Select-Object -First 1
        if ($null -eq $tickLabel) {
            throw "Category template axis label '$($tickLabels[$index])' is missing"
        }
        $tickPosition = Get-Translate $tickLabel
        Set-Translate $tickLabel ($plotTicks[$index] + $tickOffsets[$index]) $tickPosition[1]
    }

    $rowCenters = for ($index = 0; $index -lt 7; $index++) {
        $top = (Get-Translate $boundaries[$index])[1]
        $bottom = (Get-Translate $boundaries[$index + 1])[1]
        ($top + $bottom) / 2
    }
    $bars = @(
        $children | Where-Object {
            $rect = Get-DirectRect $_
            $null -ne $rect -and $rect.GetAttribute('height') -eq '18.9' -and $rect.GetAttribute('fill') -in @('#3867b9', '#93c5fd')
        } | Sort-Object { (Get-Translate $_)[1] }
    )
    $categoryLabels = @(
        $children | Where-Object {
            $position = Get-Translate $_
            $label = Get-LeafText $_
            $position[0] -gt 100 -and $position[0] -lt 180 -and $position[1] -gt 300 -and $position[1] -lt 800 -and $label -notmatch '%'
        } | Sort-Object { (Get-Translate $_)[1] }
    )
    $coverageLabels = @(
        $children | Where-Object {
            $position = Get-Translate $_
            (Get-LeafText $_) -match '^\d+(?:\.\d+)?%$' -and $position[0] -gt 1300 -and $position[1] -gt 300 -and $position[1] -lt 800
        } | Sort-Object { (Get-Translate $_)[1] }
    )
    $barLabels = @(
        $children | Where-Object {
            $position = Get-Translate $_
            (Get-LeafText $_) -match '^\d+(?:\.\d+)?%$' -and $position[0] -lt 1300 -and $position[1] -gt 300 -and $position[1] -lt 800
        } | Sort-Object { (Get-Translate $_)[1] }
    )
    if ($categoryLabels.Count -ne 7 -or $coverageLabels.Count -ne 7 -or $barLabels.Count -ne 14 -or $bars.Count -ne 14) {
        throw 'Category template dynamic nodes are incomplete'
    }
    for ($row = 0; $row -lt 7; $row++) {
        $item = $rows[$row]
        $download = Get-DataNumber $item 'download' "category.rows[$row].download"
        $income = Get-DataNumber $item 'income' "category.rows[$row].income"
        $coverage = Get-DataNumber $item 'coverage' "category.rows[$row].coverage"
        $center = $rowCenters[$row]
        $upper = $bars[$row * 2]
        $lower = $bars[$row * 2 + 1]
        $upperWidth = [double]$contract.category.barWidthAt100 * $download / 100
        $lowerWidth = [double]$contract.category.barWidthAt100 * $income / 100
        $upperRect = Get-DirectRect $upper
        $lowerRect = Get-DirectRect $lower
        $upperRect.SetAttribute('width', [string]::Format($culture, '{0:0.####}', $upperWidth))
        $lowerRect.SetAttribute('width', [string]::Format($culture, '{0:0.####}', $lowerWidth))
        Set-Translate $upper $contract.category.barStartX ($center - ($contract.category.barCenterGap / 2) - ($contract.category.barHeight / 2))
        Set-Translate $lower $contract.category.barStartX ($center + ($contract.category.barCenterGap / 2) - ($contract.category.barHeight / 2))

        Set-LeafText $categoryLabels[$row] ([string]$item.name)
        Set-TextCenter $categoryLabels[$row] $contract.category.categoryCenterX $center
        Set-LeafText $coverageLabels[$row] (Format-Percent $coverage)
        Set-TextCenter $coverageLabels[$row] $contract.category.coverageCenterX $center

        $upperLabel = $barLabels[$row * 2]
        $lowerLabel = $barLabels[$row * 2 + 1]
        Set-LeafText $upperLabel (Format-Percent $download)
        Set-LeafText $lowerLabel (Format-Percent $income)
        $labelGap = if ($contract.category.PSObject.Properties.Name -contains 'barLabelGap') {
            [double]$contract.category.barLabelGap
        }
        else {
            10.8
        }
        Set-Translate $upperLabel ($contract.category.barStartX + $upperWidth + $labelGap) ($center - ($contract.category.barCenterGap / 2))
        Set-Translate $lowerLabel ($contract.category.barStartX + $lowerWidth + $labelGap) ($center + ($contract.category.barCenterGap / 2))
        Set-TextVerticalCenter $upperLabel ($center - ($contract.category.barCenterGap / 2))
        Set-TextVerticalCenter $lowerLabel ($center + ($contract.category.barCenterGap / 2))
    }
    if ($ChartData.note) {
        $note = $children | Where-Object { (Get-LeafText $_) -match '^同一品类中' } | Select-Object -First 1
        Set-LeafText $note ([string]$ChartData.note)
    }
}

function Update-RegionsChart {
    param(
        [System.Xml.XmlDocument]$Svg,
        [object]$ChartData
    )

    $main = Get-MainGroup $Svg
    $children = Get-ElementChildren $main
    $legendItems = @()
    foreach ($definition in @(
        @{ Fill = '#2f67e8'; Label = '下载侧' },
        @{ Fill = '#f05a00'; Label = '收入侧' }
    )) {
        $marker = $children | Where-Object {
            $shape = $_.SelectSingleNode('./*[local-name()="ellipse" or local-name()="circle"]')
            $null -ne $shape -and $shape.GetAttribute('fill') -eq $definition.Fill
        } | Select-Object -First 1
        $text = $children | Where-Object { (Get-LeafText $_) -eq $definition.Label } | Select-Object -First 1
        if ($null -eq $marker -or $null -eq $text) {
            throw "Regions legend item not found for $($definition.Label)"
        }
        $legendItems += New-LegendItem @($marker, $text)
    }
    Set-LegendItemsCenter $legendItems ([double]$contract.regions.legendCenterX)
    $rows = @($ChartData.rows)
    if ($rows.Count -ne [int]$contract.regions.rowCount) {
        throw "regions.rows must contain $($contract.regions.rowCount) rows"
    }
    $downloadBars = @($children | Where-Object { $rect = Get-DirectRect $_; $null -ne $rect -and $rect.GetAttribute('fill') -eq '#2f67e8' -and $rect.GetAttribute('height') -eq '48.4' } | Sort-Object { (Get-Translate $_)[1] })
    $incomeBars = @($children | Where-Object { $rect = Get-DirectRect $_; $null -ne $rect -and $rect.GetAttribute('fill') -eq '#f05a00' -and $rect.GetAttribute('height') -eq '48.4' } | Sort-Object { (Get-Translate $_)[1] })
    $names = @($children | Where-Object { $position = Get-Translate $_; $position[0] -gt 700 -and $position[0] -lt 820 -and (Get-LeafText $_) -in @('US', 'IN', '拉美', '东南亚') } | Sort-Object { (Get-Translate $_)[1] })
    $downloadLabels = @($children | Where-Object { $position=Get-Translate $_; $position[0] -lt 800 -and (Get-LeafText $_) -match '^\d+(?:\.\d+)?%$' -and $position[1] -gt 300 -and $position[1] -lt 850 } | Sort-Object { (Get-Translate $_)[1] })
    $incomeLabels = @($children | Where-Object { $position=Get-Translate $_; $position[0] -ge 800 -and (Get-LeafText $_) -match '^\d+(?:\.\d+)?%$' -and $position[1] -gt 300 -and $position[1] -lt 850 } | Sort-Object { (Get-Translate $_)[1] })
    if ($downloadBars.Count -ne 4 -or $incomeBars.Count -ne 4 -or $names.Count -ne 4 -or $downloadLabels.Count -ne 4 -or $incomeLabels.Count -ne 4) {
        throw 'Regions template dynamic nodes are incomplete'
    }
    $firstCenter = (Get-Translate $downloadBars[0])[1] + ($contract.regions.barHeight / 2)
    $rowStep = 132
    for ($row = 0; $row -lt 4; $row++) {
        $item = $rows[$row]
        $download = Get-DataNumber $item 'download' "regions.rows[$row].download"
        $income = Get-DataNumber $item 'income' "regions.rows[$row].income"
        if ($download -gt $contract.regions.maximum -or $income -gt $contract.regions.maximum) {
            throw "regions.rows[$row] exceeds the fixed 35% axis"
        }
        $center = $firstCenter + ($rowStep * $row)
        $downloadWidth = 16.35 * $download
        $incomeWidth = 16.35 * $income
        $downloadRect = Get-DirectRect $downloadBars[$row]
        $incomeRect = Get-DirectRect $incomeBars[$row]
        $downloadRect.SetAttribute('width', [string]::Format($culture, '{0:0.####}', $downloadWidth))
        $incomeRect.SetAttribute('width', [string]::Format($culture, '{0:0.####}', $incomeWidth))
        Set-Translate $downloadBars[$row] ($contract.regions.downloadAxisX - $downloadWidth) ($center - ($contract.regions.barHeight / 2))
        Set-Translate $incomeBars[$row] $contract.regions.incomeStartX ($center - ($contract.regions.barHeight / 2))
        Set-LeafText $names[$row] ([string]$item.name)
        Set-TextCenter $names[$row] $contract.regions.nameCenterX $center
        Set-LeafText $downloadLabels[$row] (Format-Percent $download)
        Set-TextHorizontalAlignment $downloadLabels[$row] 'end'
        Set-Translate $downloadLabels[$row] ($contract.regions.downloadAxisX - $contract.regions.innerPadding) $center
        Set-TextVerticalCenter $downloadLabels[$row] $center
        Set-LeafText $incomeLabels[$row] (Format-Percent $income)
        Set-TextHorizontalAlignment $incomeLabels[$row] 'start'
        Set-Translate $incomeLabels[$row] ($contract.regions.incomeStartX + $contract.regions.innerPadding) $center
        Set-TextVerticalCenter $incomeLabels[$row] $center
    }
    if ($ChartData.note) {
        $note = $children | Where-Object { (Get-LeafText $_) -match '^IN、拉美、东南亚' } | Select-Object -First 1
        Set-LeafText $note ([string]$ChartData.note)
    }
}

function Save-Svg {
    param(
        [System.Xml.XmlDocument]$Svg,
        [string]$Path
    )

    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $settings.Indent = $false
    $settings.OmitXmlDeclaration = $true
    $writer = [System.Xml.XmlWriter]::Create($Path, $settings)
    try {
        $Svg.Save($writer)
    }
    finally {
        $writer.Dispose()
    }
}

function Invoke-CheckedScript {
    param(
        [string]$Path,
        [hashtable]$Arguments
    )

    $global:LASTEXITCODE = 0
    & $Path @Arguments
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "Chart processing step failed: $Path (exit code $LASTEXITCODE)"
    }
}

function Invoke-ChartRenderer {
    param(
        [string]$FileName,
        [string]$PropertyName,
        [string]$RawDir
    )

    $templatePath = Join-Path $TemplateDir $FileName
    if (-not (Test-Path -LiteralPath $templatePath)) {
        throw "Missing chart template $templatePath"
    }
    $svg = New-Object System.Xml.XmlDocument
    $svg.Load($templatePath)
    switch ($PropertyName) {
        'global' { Update-GlobalChart $svg $data.global }
        'trend' { Update-TrendChart $svg $data.trend }
        'category' { Update-CategoryChart $svg $data.category }
        'regions' { Update-RegionsChart $svg $data.regions }
        default { throw "Unsupported chart property $PropertyName" }
    }
    Save-Svg $svg (Join-Path $RawDir $FileName)
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$stageRoot = Join-Path $OutputDir '.render-stages'
if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
$rawDir = Join-Path $stageRoot 'raw'
$typographyDir = Join-Path $stageRoot 'typography'
$layoutDir = Join-Path $stageRoot 'layout'
$topDir = Join-Path $stageRoot 'top-content'
New-Item -ItemType Directory -Path $rawDir -Force | Out-Null

Invoke-ChartRenderer '01-global.svg' 'global' $rawDir
Invoke-ChartRenderer '02-trend.svg' 'trend' $rawDir
Invoke-ChartRenderer '03-category.svg' 'category' $rawDir
Invoke-ChartRenderer '04-regions.svg' 'regions' $rawDir

Invoke-CheckedScript (Join-Path $scriptRoot 'normalize-chart-typography.ps1') @{
    InputDir = $rawDir
    OutputDir = $typographyDir
}
Invoke-CheckedScript (Join-Path $scriptRoot 'normalize-chart-layout.ps1') @{
    InputDir = $typographyDir
    OutputDir = $layoutDir
}
Invoke-CheckedScript (Join-Path $scriptRoot 'normalize-chart-top-content.ps1') @{
    InputDir = $layoutDir
    OutputDir = $topDir
}

# The country chart is the approved standalone renderer for the fifth formal
# whiteboard; the other four charts continue through the shared normalizers.
Invoke-CheckedScript (Join-Path $scriptRoot 'render-category-countries-chart.ps1') @{
    DataPath = $DataPath
    OutputPath = Join-Path $topDir '04-countries.svg'
}
Copy-Item -LiteralPath (Join-Path $topDir '04-regions.svg') -Destination (Join-Path $topDir '05-regions.svg') -Force
Invoke-CheckedScript (Join-Path $scriptRoot 'verify-chart-layout.ps1') @{
    InputDir = $topDir
}

foreach ($fileName in @('01-global.svg', '02-trend.svg', '03-category.svg', '04-countries.svg', '05-regions.svg')) {
    Copy-Item -LiteralPath (Join-Path $topDir $fileName) -Destination (Join-Path $OutputDir $fileName) -Force
}
foreach ($staleFile in @('04-regions.svg', 'category-countries.svg')) {
    $stalePath = Join-Path $OutputDir $staleFile
    if (Test-Path -LiteralPath $stalePath) {
        Remove-Item -LiteralPath $stalePath -Force
    }
}

Remove-Item -LiteralPath $stageRoot -Recurse -Force
Write-Output "MARKET_CHART_RENDER: PASS ($OutputDir)"
