param(
    [Parameter(Mandatory = $true)]
    [string]$Content,

    [string]$ExamplesPath
)

$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()

if (Test-Path -LiteralPath $Content -PathType Leaf) {
    $Content = Get-Content -LiteralPath $Content -Raw -Encoding UTF8
}

function Add-CheckError {
    param([string]$Message)

    [void]$script:errors.Add($Message)
}

function Get-NodeText {
    param([System.Xml.XmlNode[]]$Nodes)

    return ((@($Nodes) | ForEach-Object { $_.InnerText }) -join ' ' -replace '\r|\n', ' ' -replace '\s+', ' ').Trim()
}

function Get-FormulaCount {
    param([System.Xml.XmlNode[]]$Nodes)

    $nodeArray = @($Nodes)
    $text = Get-NodeText $nodeArray
    $textCount = [regex]::Matches($text, '\$\$[\s\S]*?\$\$').Count
    $elementCount = @(
        $nodeArray | ForEach-Object {
            @($_.SelectNodes('.//*[local-name()="latex" or local-name()="equation" or local-name()="formula"]'))
        }
    ).Count
    return [Math]::Max($textCount, $elementCount)
}

function Get-DirectSections {
    param([System.Xml.XmlElement]$Root)

    $children = @($Root.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })
    $headings = @($children | Where-Object { $_.LocalName -eq 'h1' })
    $sections = [System.Collections.Generic.List[object]]::new()

    for ($headingIndex = 0; $headingIndex -lt $headings.Count; $headingIndex++) {
        $heading = $headings[$headingIndex]
        $start = -1
        for ($childIndex = 0; $childIndex -lt $children.Count; $childIndex++) {
            if ([object]::ReferenceEquals($children[$childIndex], $heading)) {
                $start = $childIndex
                break
            }
        }
        if ($start -lt 0) { continue }

        $end = $children.Count
        if ($headingIndex -lt ($headings.Count - 1)) {
            for ($childIndex = $start + 1; $childIndex -lt $children.Count; $childIndex++) {
                if ([object]::ReferenceEquals($children[$childIndex], $headings[$headingIndex + 1])) {
                    $end = $childIndex
                    break
                }
            }
        }

        $sectionNodes = if ($end -gt $start) { @($children[$start..($end - 1)]) } else { @($heading) }
        [void]$sections.Add([pscustomobject]@{
                Heading = [string]$heading.InnerText.Trim()
                Nodes = $sectionNodes
                Text = Get-NodeText $sectionNodes
            })
    }

    return @($sections)
}

function Find-Section {
    param(
        [object[]]$Sections,
        [string]$Pattern
    )

    return $Sections | Where-Object { $_.Heading -match $Pattern } | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($ExamplesPath)) {
    $ExamplesPath = Join-Path $PSScriptRoot '..\references\examples.md'
}

if ($Content.TrimStart().StartsWith('{')) {
    $payload = $Content | ConvertFrom-Json
    if (-not $payload.ok -or $null -eq $payload.data.document.content) {
        throw 'The supplied document payload does not contain readable document content'
    }
    $Content = [string]$payload.data.document.content
}

try {
    [xml]$document = '<root>' + $Content + '</root>'
}
catch {
    throw "Document content is not valid XML: $($_.Exception.Message)"
}

$root = $document.DocumentElement
$headings = @($root.SelectNodes('./h1'))
if ($headings.Count -ne 7) {
    Add-CheckError "Document must contain 7 h1 elements, got $($headings.Count)"
}

$sections = Get-DirectSections $root
$scopeSection = Find-Section $sections '数据范围.*口径|数据范围.*计算'
if ($null -eq $scopeSection) {
    Add-CheckError 'The data-range and methodology section is missing'
}

$formulaSectionCount = 0
foreach ($section in $sections) {
    $formulaCount = Get-FormulaCount $section.Nodes
    if ($formulaCount -gt 0) {
        if ($null -ne $scopeSection -and [object]::ReferenceEquals($section, $scopeSection)) {
            $formulaSectionCount = $formulaCount
        }
        else {
            Add-CheckError "Formulas must appear only in the data-range and methodology section, found in '$($section.Heading)'"
        }
    }
}

if ($null -ne $scopeSection) {
    if ($formulaSectionCount -lt 3) {
        Add-CheckError "The data-range and methodology section must contain at least 3 inline formulas, got $formulaSectionCount"
    }

    $formulaParagraphs = @(
        $scopeSection.Nodes |
            ForEach-Object { @($_.SelectNodes('.//*[local-name()="p"]')) } |
            Where-Object { $_.InnerText -match '\$\$[\s\S]*?\$\$' -or $null -ne $_.SelectSingleNode('.//*[local-name()="latex" or local-name()="equation" or local-name()="formula"]') }
    )
    foreach ($paragraph in $formulaParagraphs) {
        $paragraphText = $paragraph.InnerText.Trim()
        if ($paragraphText -match '^\s*\$\$[\s\S]*?\$\$\s*$') {
            Add-CheckError 'A formula must stay inline with explanatory text and cannot occupy a paragraph by itself'
        }
    }

    $requiredDefinitions = @(
        'i (index)',
        's (side)',
        'g (group)',
        'h (Top5 country or region index)',
        'x (raw share value)',
        'p (normalized share)',
        'P (aggregated share)',
        'V_s (valid record set)',
        'N_s (record count)',
        'Top5 (top five countries or regions)',
        'IAA (in-app advertising)',
        'IAP (in-app purchase)',
        'C (coverage rate)',
        'c (category)',
        'R_c (valid income records)',
        'A_c (all records)'
    )
    foreach ($definition in $requiredDefinitions) {
        if ($scopeSection.Text -notlike "*$definition*") {
            Add-CheckError "Missing variable or term definition: $definition"
        }
    }
}

$allText = $root.InnerText
if ($allText -match '\([^()\r\n]*[\u4e00-\u9fff][^()\r\n]*\)') {
    Add-CheckError 'An ASCII parenthesis pair contains Chinese text; use full-width parentheses'
}
if ($allText -match '（[A-Za-z0-9][A-Za-z0-9 _+./-]*）') {
    Add-CheckError 'A full-width parenthesis pair contains English-only text; use ASCII parentheses'
}

$nestedLists = @($root.SelectNodes('.//ol//ol'))
if ($nestedLists.Count -eq 0) {
    Add-CheckError 'The report must contain a native nested ordered list for variable definitions'
}
foreach ($list in $nestedLists) {
    if ($list.HasAttribute('type')) {
        Add-CheckError 'Nested ordered lists must not use the type attribute'
    }
    foreach ($item in @($list.SelectNodes('./li'))) {
        # Feishu preserves seq="auto" on write but may normalize it to seq="1" on the first item
        # and omit it on subsequent items when the document is read back.
        $seq = if ($item.HasAttribute('seq')) { $item.GetAttribute('seq') } else { '' }
        if ($seq -notin @('', '1', 'auto')) {
            Add-CheckError 'Nested ordered-list items must use native automatic sequencing'
        }
        if ($item.InnerText -match '^\s*[a-z]\.\s') {
            Add-CheckError 'Nested ordered-list letters must be generated by Feishu, not typed into the item text'
        }
    }
}
if ($Content -match '<ol[^>]*type\s*=\s*["'']a["'']') {
    Add-CheckError 'The report contains an unsupported type="a" ordered list'
}

$summarySection = Find-Section $sections '综合总结|总结'
if ($null -eq $summarySection) {
    Add-CheckError 'The execution and conclusion section must contain the integrated summary'
}
else {
    $summaryKeywords = @('整体数据特征', '发展趋势', 'IAA', 'IAP', '收入数据覆盖率')
    foreach ($keyword in $summaryKeywords) {
        if ($summarySection.Text -notlike "*$keyword*") {
            Add-CheckError "Integrated summary is missing: $keyword"
        }
    }
    if ($summarySection.Text.Length -lt 220) {
        Add-CheckError 'Integrated summary is too short; explain the full data pattern, trend, category-country focus and coverage limits'
    }
    if ($summarySection.Text -notmatch '印度|印度尼西亚|巴西|美国|德国|英国') {
        Add-CheckError 'Integrated summary must name concrete countries or regions'
    }

    $summaryLists = @(
        $summarySection.Nodes |
            ForEach-Object {
                $candidates = @($_.SelectNodes('.//ol'))
                if ($_.LocalName -eq 'ol') { $candidates += $_ }
                $candidates
            }
    )
    if ($summaryLists.Count -eq 0) {
        Add-CheckError 'The integrated summary must use a native ordered list'
    }
    else {
        $summaryList = $summaryLists |
            Sort-Object { @($_.SelectNodes('./li')).Count } -Descending |
            Select-Object -First 1
        $summaryItems = @($summaryList.SelectNodes('./li'))
        if ($summaryItems.Count -lt 5) {
            Add-CheckError "The integrated summary ordered list must contain at least 5 items, got $($summaryItems.Count)"
        }
        foreach ($item in $summaryItems) {
            if ($item.InnerText -match '^\s*\d+[\.、．]\s') {
                Add-CheckError 'Ordered-list numbers must be generated by Feishu, not typed into the item text'
            }
            if ($item.InnerText -match '^\s*[a-z]\.\s') {
                Add-CheckError 'Ordered-list letters must be generated by Feishu, not typed into the item text'
            }
        }
    }
}

if (-not (Test-Path -LiteralPath $ExamplesPath)) {
    Add-CheckError "Examples file does not exist: $ExamplesPath"
}
else {
    $examplesText = Get-Content -LiteralPath $ExamplesPath -Raw -Encoding UTF8
    for ($index = 1; $index -le 15; $index++) {
        $headingPattern = "(?m)^### $index\."
        $match = [regex]::Match($examplesText, $headingPattern)
        if (-not $match.Success) {
            Add-CheckError "Examples file is missing rule $index"
            continue
        }
        $nextMatch = [regex]::Match($examplesText.Substring($match.Index + $match.Length), '(?m)^### \d+\.')
        $sectionText = if ($nextMatch.Success) {
            $examplesText.Substring($match.Index, $match.Length + $nextMatch.Index)
        }
        else {
            $examplesText.Substring($match.Index)
        }
        if ($sectionText -notmatch '规则：') {
            Add-CheckError "Examples for rule $index are missing the rule text"
        }
        if ($sectionText -notmatch '示例：') {
            Add-CheckError "Examples for rule $index are missing an example"
        }
    }
}

if ($errors.Count -gt 0) {
    Write-Output 'REPORT_CONTRACT_CHECK: FAIL'
    $errors | ForEach-Object { Write-Output "- $_" }
    exit 1
}

Write-Output 'REPORT_CONTRACT_CHECK: PASS'
