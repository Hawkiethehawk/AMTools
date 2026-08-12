param(
    [Parameter(Mandatory = $true)]
    [string]$InputDir,

    [Parameter(Mandatory = $true)]
    [string]$OutputDir,

    [string[]]$ChartFile = @()
)

$ErrorActionPreference = 'Stop'
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$fixedLegendGap = 49

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
        [double]$DeltaY
    )

    $position = Get-Translate $Node
    Set-Translate $Node $position[0] ($position[1] + $DeltaY)
}

function Get-YToAncestor {
    param(
        [System.Xml.XmlElement]$Node,
        [System.Xml.XmlElement]$Ancestor
    )

    $sum = 0.0
    $current = $Node
    while ($null -ne $current -and $current -ne $Ancestor) {
        if ($current.NodeType -eq 'Element' -and $current.HasAttribute('transform')) {
            $sum += (Get-Translate $current)[1]
        }
        $current = $current.ParentNode
    }

    if ($current -ne $Ancestor) {
        throw "Ancestor not found for node $($Node.GetAttribute('id'))"
    }

    return $sum
}

function Get-ShapeCenterY {
    param(
        [System.Xml.XmlElement]$Shape,
        [System.Xml.XmlElement]$Container
    )

    $relativeY = Get-YToAncestor $Shape $Container
    if ($Shape.LocalName -eq 'ellipse' -or $Shape.LocalName -eq 'circle') {
        $center = [double]::Parse($Shape.GetAttribute('cy'), $culture)
    }
    else {
        $y = if ($Shape.HasAttribute('y')) {
            [double]::Parse($Shape.GetAttribute('y'), $culture)
        }
        else {
            0.0
        }
        $height = [double]::Parse($Shape.GetAttribute('height'), $culture)
        $center = $y + ($height / 2)
    }

    return $relativeY + $center
}

function Get-FirstSmallLegendShape {
    param([System.Xml.XmlElement]$Node)

    return $Node.SelectSingleNode(
        ".//*[local-name()='rect' or local-name()='ellipse' or local-name()='circle'][@width <= 20 or @rx <= 10]"
    )
}

function Set-GroupedLegendGap {
    param(
        [System.Xml.XmlElement]$Main,
        [System.Xml.XmlElement]$TopRule,
        [System.Xml.XmlElement]$Legend
    )

    $shape = Get-FirstSmallLegendShape $Legend
    if ($null -eq $shape) {
        throw "Legend marker not found in $($Legend.GetAttribute('id'))"
    }

    $topRuleY = (Get-Translate $TopRule)[1]
    $legendPosition = Get-Translate $Legend
    $currentCenterY = $legendPosition[1] + (Get-ShapeCenterY $shape $Legend)
    $targetCenterY = $topRuleY + $fixedLegendGap
    Move-Node $Legend ($targetCenterY - $currentCenterY)
}

function Set-MultiNodeLegendGap {
    param(
        [System.Xml.XmlElement]$TopRule,
        [System.Xml.XmlElement[]]$LegendNodes,
        [System.Xml.XmlElement]$AnchorNode,
        [double]$AnchorOffsetY = 0
    )

    $topRuleY = (Get-Translate $TopRule)[1]
    $anchorY = (Get-Translate $AnchorNode)[1] + $AnchorOffsetY
    $targetCenterY = $topRuleY + $fixedLegendGap
    $deltaY = $targetCenterY - $anchorY

    foreach ($node in $LegendNodes) {
        Move-Node $node $deltaY
    }
}

function Update-Chart {
    param(
        [System.Xml.XmlElement]$Main,
        [string]$FileName
    )

    $children = Get-ElementChildren $Main
    if ($children.Count -lt 4) {
        throw "Header and legend nodes not found in $FileName"
    }

    $topRule = $children[2]
    $topRulePath = $topRule.SelectSingleNode("./*[local-name()='path']")
    if ($null -eq $topRulePath) {
        throw "Top divider not found in $FileName"
    }

    switch ($FileName) {
        '01-global.svg' {
            $legend = $children |
                Where-Object { $_.InnerText.Trim() -eq 'UST1T2T3其他' } |
                Select-Object -First 1
            if ($null -eq $legend) {
                throw "Global legend not found in $FileName"
            }
            Set-GroupedLegendGap $Main $topRule $legend
        }

        '03-category.svg' {
            $legend = $children |
                Where-Object { $_.InnerText.Trim() -eq '下载T2+T3收入US+T1' } |
                Select-Object -First 1
            if ($null -eq $legend) {
                throw "Category legend not found in $FileName"
            }
            Set-GroupedLegendGap $Main $topRule $legend
        }

        '02-trend.svg' {
            $axisLabel = $children |
                Where-Object { $_.InnerText.Trim() -eq '占比（%）' } |
                Select-Object -First 1
            if ($null -eq $axisLabel) {
                throw "Trend axis label not found in $FileName"
            }

            $axisY = (Get-Translate $axisLabel)[1]
            $legendNodes = @(
                $children |
                    Where-Object {
                        $position = Get-Translate $_
                        $position[1] -gt (Get-Translate $topRule)[1] -and
                        $position[1] -lt $axisY
                    }
            )
            $anchor = $legendNodes |
                Where-Object {
                    $path = $_.SelectSingleNode("./*[local-name()='path']")
                    $null -ne $path -and $path.GetAttribute('d') -eq 'M 0 0 L 28.08 0'
                } |
                Select-Object -First 1
            if ($null -eq $anchor -or $legendNodes.Count -eq 0) {
                throw "Trend legend not found in $FileName"
            }
            Set-MultiNodeLegendGap $topRule $legendNodes $anchor
        }

        '04-regions.svg' {
            $legendNodes = @(
                $children |
                    Where-Object {
                        $label = $_.InnerText.Trim()
                        $marker = $_.SelectSingleNode("./*[local-name()='ellipse' or local-name()='circle']")
                        $label -in @('下载侧', '收入侧') -or
                        ($null -ne $marker -and $marker.GetAttribute('fill') -in @('#2f67e8', '#f05a00'))
                    }
            )
            $anchor = $legendNodes |
                Where-Object {
                    $shape = $_.SelectSingleNode("./*[local-name()='ellipse' or local-name()='circle']")
                    $null -ne $shape -and $shape.GetAttribute('fill') -eq '#2f67e8'
                } |
                Select-Object -First 1
            if ($null -eq $anchor -or $legendNodes.Count -eq 0) {
                throw "Region legend not found in $FileName"
            }
            $shape = $anchor.SelectSingleNode("./*[local-name()='ellipse' or local-name()='circle']")
            $anchorOffsetY = [double]::Parse($shape.GetAttribute('cy'), $culture)
            Set-MultiNodeLegendGap $topRule $legendNodes $anchor $anchorOffsetY
        }

        default {
            throw "Unsupported chart file '$FileName'"
        }
    }
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$supportedFiles = @(
    '01-global.svg',
    '02-trend.svg',
    '03-category.svg',
    '04-regions.svg'
)
$filesToProcess = if ($ChartFile.Count -gt 0) {
    foreach ($fileName in $ChartFile) {
        if ($supportedFiles -notcontains $fileName) {
            throw "Unsupported chart file '$fileName'"
        }
        $fileName
    }
}
else {
    $supportedFiles
}

foreach ($fileName in $filesToProcess) {
    $sourcePath = Join-Path $InputDir $fileName
    $targetPath = Join-Path $OutputDir $fileName
    [xml]$svg = Get-Content -LiteralPath $sourcePath -Raw
    $groups = Get-ElementChildren $svg.DocumentElement
    if ($groups.Count -lt 2) {
        throw "Expected background and content groups in $fileName"
    }

    Update-Chart $groups[1] $fileName

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
