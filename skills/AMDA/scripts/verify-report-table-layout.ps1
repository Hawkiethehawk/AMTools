param(
    [Parameter(Mandatory = $true)]
    [string]$Content
)

$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()

if (Test-Path -LiteralPath $Content -PathType Leaf) {
    $Content = Get-Content -LiteralPath $Content -Raw -Encoding UTF8
}

$tableContracts = @(
    [pscustomobject]@{
        Name = '全球主分组结构表'
        Headers = @('主分层', '下载侧全历史', '下载侧最近4周', '收入侧全历史', '收入侧最近4周', '分组角色')
        Widths = @(66, 108, 117, 108, 117, 304)
        Rows = 4
        CenterColumnCount = 5
    },
    [pscustomobject]@{
        Name = '全部周期趋势表'
        Headers = @('指标', '全历史', '前4周', '最近4周', '近期变化', '近期特征')
        Widths = @(122, 66, 65, 75, 80, 412)
        Rows = 3
        CenterColumnCount = 5
        PercentageChangeColumn = 5
    },
    [pscustomobject]@{
        Name = '分品类决策表'
        Headers = @('品类', 'IAA规模层', 'IAP观察层', '收入数据覆盖率', '近期信号')
        Widths = @(122, 90, 89, 122, 397)
        Rows = 7
        CenterColumnCount = 5
    },
    [pscustomobject]@{
        Name = '分品类IAA重点国家表'
        Headers = @('品类', 'IAA核心分组', '下载侧重点国家', '全历史/最近4周')
        Widths = @(122, 174, 236, 288)
        Rows = 7
        CenterColumnCount = 4
    },
    [pscustomobject]@{
        Name = '组内国家诊断表'
        Headers = @('分组/观察组', '重点国家', '下载侧全历史', '下载侧最近4周', '收入全/近4周', '观察结论')
        Widths = @(108, 94, 108, 117, 111, 282)
        Rows = 7
        CenterColumnCount = 4
    }
)

function Add-CheckError {
    param([string]$Message)

    [void]$script:errors.Add($Message)
}

function Get-EstimatedNoWrapWidth {
    param([string]$Text)

    $width = 20
    foreach ($character in $Text.ToCharArray()) {
        if ($character -match '[一-龥]') {
            $width += 13
        }
        elseif ($character -match '[A-Za-z0-9]') {
            $width += 7
        }
        elseif ($character -match '[+/\-]') {
            $width += 6
        }
        else {
            $width += 5
        }
    }

    return $width
}

function Get-DirectParagraph {
    param(
        [System.Xml.XmlElement]$Cell,
        [string]$Label
    )

    $paragraphs = @($Cell.SelectNodes('./p'))
    if ($paragraphs.Count -ne 1) {
        Add-CheckError "$Label must contain exactly one paragraph"
        return $null
    }

    $paragraph = $paragraphs[0]
    if ($null -ne $paragraph.SelectSingleNode('.//br')) {
        Add-CheckError "$Label contains a forced line break"
    }

    return $paragraph
}

function Get-CellParagraphs {
    param(
        [System.Xml.XmlElement]$Cell,
        [string]$Label
    )

    $paragraphs = @($Cell.SelectNodes('./p'))
    if ($paragraphs.Count -eq 0) {
        Add-CheckError "$Label must contain at least one paragraph"
        return @()
    }

    return $paragraphs
}

function Test-CellHasLineBreak {
    param([System.Xml.XmlElement]$Cell)

    if ($null -ne $Cell.SelectSingleNode('.//br')) {
        return $true
    }

    if (@($Cell.SelectNodes('./p')).Count -gt 1) {
        return $true
    }

    return $Cell.InnerXml -match '\r|\n'
}

function Get-ParagraphLines {
    param([System.Xml.XmlElement]$Paragraph)

    $lines = [System.Collections.Generic.List[string]]::new()
    $current = [System.Text.StringBuilder]::new()
    foreach ($node in $Paragraph.ChildNodes) {
        if ($node.NodeType -eq [System.Xml.XmlNodeType]::Element -and $node.LocalName -eq 'br') {
            [void]$lines.Add($current.ToString())
            [void]$current.Clear()
        }
        elseif ($node.NodeType -eq [System.Xml.XmlNodeType]::Text) {
            [void]$current.Append($node.Value)
        }
        else {
            [void]$current.Append($node.InnerText)
        }
    }
    [void]$lines.Add($current.ToString())
    return @($lines)
}

function Test-CellWouldAutoWrap {
    param(
        [System.Xml.XmlElement]$Cell,
        [int]$ColumnWidth
    )

    foreach ($paragraph in @($Cell.SelectNodes('./p'))) {
        foreach ($line in (Get-ParagraphLines $paragraph)) {
            if ((Get-EstimatedNoWrapWidth $line.Trim()) -gt $ColumnWidth) {
                return $true
            }
        }
    }
    return $false
}

function Get-CellPlainText {
    param([System.Xml.XmlElement]$Cell)

    return (($Cell.InnerText -replace '\r|\n', ' ') -replace '\s+', ' ').Trim()
}

function Add-TablePunctuationErrors {
    param(
        [System.Xml.XmlElement]$Cell,
        [string]$Label
    )

    $text = Get-CellPlainText $Cell
    if ($text -match '。') {
        Add-CheckError "$Label contains a Chinese full stop"
    }
    if ($text -match '[；;]') {
        Add-CheckError "$Label contains a semicolon; replace it with a line break"
    }
    if ($text -match '(?<!\d)\.(?!\d)') {
        Add-CheckError "$Label contains a sentence period"
    }
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
$tables = @($root.SelectNodes('./table'))
$expectedStructure = @{
    h1 = 7
    table = 5
    callout = 10
    whiteboard = 5
}
foreach ($entry in $expectedStructure.GetEnumerator()) {
    $actual = @($root.SelectNodes("./$($entry.Key)")).Count
    if ($actual -ne $entry.Value) {
        Add-CheckError "Document $($entry.Key) count must be $($entry.Value), got $actual"
    }
}

if ($tables.Count -ne $tableContracts.Count) {
    Add-CheckError "Document table count must be $($tableContracts.Count), got $($tables.Count)"
}

for ($tableIndex = 0; $tableIndex -lt [Math]::Min($tables.Count, $tableContracts.Count); $tableIndex++) {
    $table = $tables[$tableIndex]
    $contract = $tableContracts[$tableIndex]
    $columns = @($table.SelectNodes('./colgroup/col'))
    if ($columns.Count -ne $contract.Widths.Count) {
        Add-CheckError "$($contract.Name) must contain $($contract.Widths.Count) columns, got $($columns.Count)"
        continue
    }

    $totalWidth = 0
    for ($columnIndex = 0; $columnIndex -lt $columns.Count; $columnIndex++) {
        $actualWidth = [int]$columns[$columnIndex].GetAttribute('width')
        $expectedWidth = $contract.Widths[$columnIndex]
        $totalWidth += $actualWidth
        if ($actualWidth -ne $expectedWidth) {
            Add-CheckError "$($contract.Name) column $($columnIndex + 1) width must be $expectedWidth, got $actualWidth"
        }
    }
    if ($totalWidth -ne 820) {
        Add-CheckError "$($contract.Name) total width must be 820, got $totalWidth"
    }

    $headers = @($table.SelectNodes('./thead/tr/th'))
    if ($headers.Count -ne $contract.Headers.Count) {
        Add-CheckError "$($contract.Name) header count must be $($contract.Headers.Count), got $($headers.Count)"
        continue
    }
    for ($columnIndex = 0; $columnIndex -lt $headers.Count; $columnIndex++) {
        $cell = $headers[$columnIndex]
        Add-TablePunctuationErrors $cell "$($contract.Name) header $($columnIndex + 1)"
        if ($cell.GetAttribute('vertical-align') -ne 'middle') {
            Add-CheckError "$($contract.Name) header $($columnIndex + 1) is not vertically centered"
        }
        $paragraph = Get-DirectParagraph $cell "$($contract.Name) header $($columnIndex + 1)"
        if ($null -eq $paragraph) { continue }
        if ($paragraph.GetAttribute('align') -ne 'center') {
            Add-CheckError "$($contract.Name) header $($columnIndex + 1) is not horizontally centered"
        }
        if ($paragraph.InnerText.Trim() -ne $contract.Headers[$columnIndex]) {
            Add-CheckError "$($contract.Name) header $($columnIndex + 1) text does not match the contract"
        }
        if ((Get-EstimatedNoWrapWidth $paragraph.InnerText.Trim()) -gt $contract.Widths[$columnIndex]) {
            Add-CheckError "$($contract.Name) header $($columnIndex + 1) is too narrow for one line"
        }
    }

    $bodyRows = @($table.SelectNodes('./tbody/tr'))
    if ($bodyRows.Count -ne $contract.Rows) {
        Add-CheckError "$($contract.Name) body row count must be $($contract.Rows), got $($bodyRows.Count)"
    }
    $columnNeedsAutoWrap = @(
        for ($columnIndex = 0; $columnIndex -lt $contract.Widths.Count; $columnIndex++) {
            $needsAutoWrap = $false
            foreach ($row in $bodyRows) {
                $rowCells = @($row.SelectNodes('./td'))
                if ($rowCells.Count -eq $contract.Widths.Count -and (Test-CellWouldAutoWrap $rowCells[$columnIndex] $contract.Widths[$columnIndex])) {
                    $needsAutoWrap = $true
                    break
                }
            }
            $needsAutoWrap
        }
    )

    foreach ($row in $bodyRows) {
        $cells = @($row.SelectNodes('./td'))
        if ($cells.Count -ne $contract.Widths.Count) {
            Add-CheckError "$($contract.Name) body row has $($cells.Count) cells, expected $($contract.Widths.Count)"
            continue
        }
        for ($columnIndex = 0; $columnIndex -lt $cells.Count; $columnIndex++) {
            $cell = $cells[$columnIndex]
            $cellLabel = "$($contract.Name) row $($row.GetAttribute('id')) column $($columnIndex + 1)"
            Add-TablePunctuationErrors $cell $cellLabel
            if ($cell.GetAttribute('vertical-align') -ne 'middle') {
                Add-CheckError "$cellLabel is not vertically centered"
            }
            $paragraphs = Get-CellParagraphs $cell $cellLabel
            if ($paragraphs.Count -eq 0) { continue }

            $expectedAlign = if ($columnNeedsAutoWrap[$columnIndex]) { 'left' } else { 'center' }
            foreach ($paragraph in $paragraphs) {
                # Feishu omits the explicit left alignment attribute on readback because left is the native default.
                $alignIsValid = if ($expectedAlign -eq 'left') {
                    -not $paragraph.HasAttribute('align') -or $paragraph.GetAttribute('align') -eq 'left'
                }
                else {
                    $paragraph.HasAttribute('align') -and $paragraph.GetAttribute('align') -eq 'center'
                }
                if (-not $alignIsValid) {
                    Add-CheckError "$cellLabel must be horizontally $expectedAlign because the column $(
                        if ($columnNeedsAutoWrap[$columnIndex]) { 'requires automatic wrapping' } else { 'does not require automatic wrapping' }
                    )"
                }
            }
            if (-not $columnNeedsAutoWrap[$columnIndex]) {
                foreach ($paragraph in $paragraphs) {
                    foreach ($line in (Get-ParagraphLines $paragraph)) {
                        if ((Get-EstimatedNoWrapWidth $line.Trim()) -gt $contract.Widths[$columnIndex]) {
                            Add-CheckError "$cellLabel has a line too wide for the column: '$($line.Trim())'"
                        }
                    }
                }
            }
        }
    }

    if ($null -ne $contract.PSObject.Properties['PercentageChangeColumn']) {
        foreach ($row in @($table.SelectNodes('./tbody/tr'))) {
            $changeCell = @($row.SelectNodes('./td'))[$contract.PercentageChangeColumn - 1]
            $changeParagraph = Get-DirectParagraph $changeCell "$($contract.Name) recent-change cell"
            if ($null -eq $changeParagraph) { continue }
            $changeText = Get-CellPlainText $changeCell
            if ($changeText -notmatch '^[+-]\d+(?:\.\d+)?%$') {
                Add-CheckError "$($contract.Name) recent-change value '$changeText' must use a signed percentage"
            }
        }
    }
}

if ($tables.Count -ge 3) {
    $decisionRows = @($tables[2].SelectNodes('./tbody/tr'))
    foreach ($row in $decisionRows) {
        $cells = @($row.SelectNodes('./td'))
        if ($cells.Count -ne 5) { continue }
        $coverageMatch = [regex]::Match($cells[3].InnerText, '(\d+(?:\.\d+)?)%')
        if (-not $coverageMatch.Success) { continue }
        $coverage = [double]$coverageMatch.Groups[1].Value
        $iapText = $cells[2].InnerText
        if ($coverage -lt 50 -and $iapText -notmatch '（方向性）') {
            Add-CheckError "分品类决策表 row $($row.GetAttribute('id')) must retain the （方向性） marker when income coverage is below 50%"
        }
        if ($coverage -ge 50 -and $iapText -match '（方向性）') {
            Add-CheckError "分品类决策表 row $($row.GetAttribute('id')) must not retain the （方向性） marker when income coverage is at least 50%"
        }
    }
}

$plainText = $root.InnerText
if ($plainText -match '百分点') {
    Add-CheckError 'Use signed percentages for changes; do not use 百分点'
}
if ($plainText -match '(?<=[一-龥]) (?=[A-Za-z0-9%])|(?<=[A-Za-z0-9%]) (?=[一-龥])') {
    Add-CheckError 'Chinese and English, numbers, or percentages contain forbidden boundary spaces'
}

if ($errors.Count -gt 0) {
    Write-Output 'REPORT_TABLE_LAYOUT_CHECK: FAIL'
    $errors | ForEach-Object { Write-Output "- $_" }
    exit 1
}

Write-Output 'REPORT_TABLE_LAYOUT_CHECK: PASS'
