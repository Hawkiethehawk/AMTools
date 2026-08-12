param(
    [Parameter(Mandatory = $true)]
    [string]$Content,

    [string]$ExpectedTitle = '',
    [switch]$RemoteReadback
)

$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()

function Add-Error([string]$Message) {
    [void]$script:errors.Add($Message)
}

if (Test-Path -LiteralPath $Content -PathType Leaf) {
    $raw = Get-Content -LiteralPath $Content -Raw -Encoding UTF8
}
else {
    $raw = $Content
}

if ($raw.TrimStart().StartsWith('{')) {
    try {
        $payload = $raw | ConvertFrom-Json
        if ($payload.data.document.content) { $raw = [string]$payload.data.document.content }
    }
    catch {
        throw "Document payload is not valid JSON: $($_.Exception.Message)"
    }
}

try {
    [xml]$document = '<root>' + $raw + '</root>'
}
catch {
    throw "Document content is not valid XML: $($_.Exception.Message)"
}

$root = $document.DocumentElement
$expectedH1 = @(
    '核心观点速读',
    '数据范围与口径',
    '一、全球分组概览：规模层与收入层分离',
    '二、近期趋势与数据可信度',
    '三、品类×分组结构：规模层与收入层分开看',
    '四、组内国家诊断：国家用于解释分组稳定性',
    '五、总结'
)
$h1 = @($root.SelectNodes('./h1'))
if ($h1.Count -ne $expectedH1.Count) { Add-Error "Document must contain $($expectedH1.Count) h1 elements, got $($h1.Count)" }
for ($index = 0; $index -lt [math]::Min($h1.Count, $expectedH1.Count); $index++) {
    if ($h1[$index].InnerText.Trim() -ne $expectedH1[$index]) {
        Add-Error "h1 $($index + 1) must be '$($expectedH1[$index])'"
    }
}

$title = $root.SelectSingleNode('./title')
if ($null -eq $title) {
    Add-Error 'Document title is missing'
}
elseif ($ExpectedTitle -and $title.InnerText.Trim() -ne $ExpectedTitle) {
    Add-Error "Document title must be '$ExpectedTitle'"
}

$h2 = @($root.SelectNodes('./h2'))
if ($h2.Count -ne 1 -or $h2[0].InnerText.Trim() -ne '分品类IAA重点国家') {
    Add-Error 'The single h2 must be 分品类IAA重点国家'
}

$whiteboards = @($root.SelectNodes('./whiteboard'))
if ($whiteboards.Count -ne 5) { Add-Error "Document must contain five whiteboards, got $($whiteboards.Count)" }
foreach ($board in $whiteboards) {
    if (-not $RemoteReadback -and $board.GetAttribute('type') -ne 'svg') {
        Add-Error 'Every local chart whiteboard must use type=svg'
    }
    if ($board.GetAttribute('type') -eq 'mermaid') { Add-Error 'Mermaid whiteboards are not allowed in the formal AMDA report' }
}
if (@($root.SelectNodes('.//img')).Count -gt 0) { Add-Error 'Chart images must not be inserted as img blocks' }

$sectionHeadings = @($root.SelectNodes('./h1'))
function Get-SectionElements([int]$Index) {
    $start = $sectionHeadings[$Index]
    $end = $root.ChildNodes.Count
    if ($Index -lt ($sectionHeadings.Count - 1)) {
        for ($childIndex = 0; $childIndex -lt $root.ChildNodes.Count; $childIndex++) {
            if ([object]::ReferenceEquals($root.ChildNodes[$childIndex], $sectionHeadings[$Index + 1])) {
                $end = $childIndex
                break
            }
        }
    }
    $startIndex = -1
    for ($childIndex = 0; $childIndex -lt $root.ChildNodes.Count; $childIndex++) {
        if ([object]::ReferenceEquals($root.ChildNodes[$childIndex], $start)) { $startIndex = $childIndex; break }
    }
    if ($startIndex -lt 0 -or $end -le $startIndex) { return @() }
    return @($root.ChildNodes[($startIndex + 1)..($end - 1)] | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })
}

$core = Get-SectionElements 0
$coreLists = @($core | Where-Object { $_.LocalName -eq 'ol' })
if ($coreLists.Count -ne 1 -or @($coreLists[0].SelectNodes('./li')).Count -ne 5) {
    Add-Error '核心观点速读 must be one native ordered list with five items'
}

$scope = Get-SectionElements 1
$scopeLists = @($scope | Where-Object { $_.LocalName -eq 'ol' })
if ($scopeLists.Count -lt 1) { Add-Error '数据范围与口径 must contain a native ordered list' }
$scopeText = (@($scope | ForEach-Object { $_.InnerText }) -join '|')
$latexCount = @($scope | ForEach-Object { @($_.SelectNodes('.//latex')) }).Count
if ($latexCount -ne 3) { Add-Error "数据范围与口径 must contain exactly three inline formulas, got $latexCount" }
$allLatex = @($root.SelectNodes('.//latex'))
if ($allLatex.Count -ne $latexCount) { Add-Error 'Formulas must appear only in 数据范围与口径' }
foreach ($term in @('i (index)', 's (side)', 'g (group)', 'h (Top5 country or region index)', 'x (raw share value)', 'p (normalized share)', 'P (aggregated share)', 'V_s (valid record set)', 'N_s (record count)', 'Top5 (top five countries or regions)', 'IAA (in-app advertising)', 'IAP (in-app purchase)', 'C (coverage rate)', 'c (category)', 'R_c (valid income records)', 'A_c (all records)')) {
    if ($scopeText -notmatch [regex]::Escape($term)) { Add-Error "Missing variable definition '$term'" }
}

foreach ($index in @(2, 3, 4, 5)) {
    $section = Get-SectionElements $index
    $firstBoard = @($section | Where-Object { $_.LocalName -eq 'whiteboard' }) | Select-Object -First 1
    if ($null -eq $firstBoard) { Add-Error "Section $($index + 1) must start with its chart whiteboard" }
}
$sectionThree = Get-SectionElements 4
$h2Index = -1
for ($index = 0; $index -lt $sectionThree.Count; $index++) {
    if ($sectionThree[$index].LocalName -eq 'h2') { $h2Index = $index; break }
}
if ($h2Index -lt 0 -or $h2Index + 1 -ge $sectionThree.Count -or $sectionThree[$h2Index + 1].LocalName -ne 'whiteboard') {
    Add-Error '分品类IAA重点国家 must be followed immediately by its SVG whiteboard'
}

$tables = @($root.SelectNodes('./table'))
$expectedRows = @(4, 3, 7, 7, 7)
if ($tables.Count -ne 5) { Add-Error "Document must contain five tables, got $($tables.Count)" }
for ($index = 0; $index -lt [math]::Min($tables.Count, $expectedRows.Count); $index++) {
    $rows = @($tables[$index].SelectNodes('./tbody/tr'))
    $decisionIapNeedsLeft = $index -eq 2 -and @($tables[$index].SelectNodes('.//td[3][contains(., "（方向性）")]')).Count -gt 0
    if ($rows.Count -ne $expectedRows[$index]) { Add-Error "Table $($index + 1) must contain $($expectedRows[$index]) body rows, got $($rows.Count)" }
    foreach ($row in $rows) {
        $cellIndex = 0
        foreach ($cell in @($row.SelectNodes('./td'))) {
            if ($cell.GetAttribute('vertical-align') -ne 'middle') { Add-Error "Table $($index + 1) has a non-middle body cell" }
            $paragraph = $cell.SelectSingleNode('./p')
            $expectedAlign = 'center'
            if ($index -eq 2 -and $cellIndex -eq 2 -and $decisionIapNeedsLeft) {
                $expectedAlign = 'left'
            }
            $actualAlign = if ($null -ne $paragraph) { $paragraph.GetAttribute('align') } else { '' }
            $alignIsValid = if ($expectedAlign -eq 'left') {
                $null -ne $paragraph -and (-not $paragraph.HasAttribute('align') -or $actualAlign -eq 'left')
            }
            else {
                $null -ne $paragraph -and $actualAlign -eq 'center'
            }
            if (-not $alignIsValid) { Add-Error "Table $($index + 1) body cell $($cellIndex + 1) must be explicitly $expectedAlign" }
            $cellIndex++
        }
    }
    foreach ($header in @($tables[$index].SelectNodes('./thead/tr/th'))) {
        if ($header.GetAttribute('vertical-align') -ne 'middle') { Add-Error "Table $($index + 1) has a non-middle header cell" }
        $paragraph = $header.SelectSingleNode('./p')
        if ($null -eq $paragraph -or $paragraph.GetAttribute('align') -ne 'center') { Add-Error "Table $($index + 1) headers must be explicitly centered" }
    }
    $tableText = $tables[$index].InnerText
    if ($tableText -match '[。；;]') { Add-Error "Table $($index + 1) contains forbidden sentence punctuation" }
}

$summary = Get-SectionElements 6
$summaryLists = @($summary | Where-Object { $_.LocalName -eq 'ol' })
if ($summaryLists.Count -ne 1 -or @($summaryLists[0].SelectNodes('./li')).Count -ne 5) {
    Add-Error '五、总结 must contain one native ordered list with five top-level items'
}
if ($summaryLists.Count -eq 1) {
    foreach ($item in @($summaryLists[0].SelectNodes('./li'))) {
        if (@($item.SelectNodes('./ol')).Count -lt 1) { Add-Error 'Each summary item must contain a native nested ordered list' }
    }
}

$allText = $root.InnerText
$proseText = (@($root.SelectNodes('./title|./h1|./h2|./p|./ol|./callout') | ForEach-Object { $_.InnerText }) -join '|')
if ($allText -match '百分点') { Add-Error 'The report must not use 百分点' }
if ($proseText -match '(?<=[\p{IsCJKUnifiedIdeographs}])\s+(?=[A-Za-z0-9%])|(?<=[A-Za-z0-9%])\s+(?=[\p{IsCJKUnifiedIdeographs}])') {
    Add-Error 'The report contains a forbidden Chinese-English boundary space'
}

if ($errors.Count -gt 0) {
    Write-Output 'REPORT_DOCUMENT_CHECK: FAIL'
    $errors | Select-Object -Unique | ForEach-Object { Write-Output "- $_" }
    exit 1
}

Write-Output 'REPORT_DOCUMENT_CHECK: PASS'
