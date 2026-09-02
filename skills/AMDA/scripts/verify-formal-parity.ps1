param(
    [Parameter(Mandatory = $true)]
    [string]$FormalContent,

    [Parameter(Mandatory = $true)]
    [string]$DemoContent
)

$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()
. (Join-Path $PSScriptRoot 'lark-style-semantics.ps1')

function Add-CheckError {
    param([string]$Message)

    [void]$script:errors.Add($Message)
}

function Read-DocumentContent {
    param([string]$Source)

    if (Test-Path -LiteralPath $Source -PathType Leaf) {
        $Source = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
    }

    if ($Source.TrimStart().StartsWith('{')) {
        $payload = $Source | ConvertFrom-Json
        if ($null -eq $payload.data -or $null -eq $payload.data.document -or $null -eq $payload.data.document.content) {
            throw 'Document payload does not contain data.document.content'
        }
        return [string]$payload.data.document.content
    }

    return $Source
}

function Parse-Document {
    param([string]$Source, [string]$Label)

    try {
        if ($Source.TrimStart().StartsWith('<root')) {
            [xml]$document = $Source
        }
        else {
            [xml]$document = '<root>' + $Source + '</root>'
        }
    }
    catch {
        throw "$Label is not valid document XML: $($_.Exception.Message)"
    }

    return $document.DocumentElement
}

function Is-DynamicAttribute {
    param([string]$Name)

    return $Name -match '^(id|token|document-id|document_id|block-id|block_id|revision-id|revision_id|parent-id|parent_id)$'
}

function Get-NormalizedAttributeValue {
    param([System.Xml.XmlAttribute]$Attribute)

    if ($Attribute.Name -notmatch '(^|-)color$') {
        return $Attribute.Value
    }
    return Get-LarkSemanticColor $Attribute.Value
}

function Get-ShapeSignature {
    param([System.Xml.XmlElement]$Node)

    if ($Node.LocalName -eq 'whiteboard') {
        return '[whiteboard]'
    }

    $attributes = @(
        $Node.Attributes |
            Where-Object {
                -not (Is-DynamicAttribute $_.Name) -and
                $_.Name -ne 'seq' -and
                # Feishu derives seq-marker labels for ordered-list rendering.
                $_.Name -ne 'seq-marker' -and
                -not ($Node.LocalName -eq 'col' -and $_.Name -eq 'width')
            } |
            Sort-Object Name |
            ForEach-Object { "$($_.Name)=$(Get-NormalizedAttributeValue $_)" }
    ) -join ';'
    $children = [System.Collections.Generic.List[string]]::new()
    foreach ($child in @($Node.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })) {
        [void]$children.Add((Get-ShapeSignature $child))
    }
    return "[$($Node.LocalName)|$attributes|$($children -join '')]"
}

function Get-NormalizedText {
    param([System.Xml.XmlElement]$Node)

    return (($Node.InnerText -replace '\s+', ' ').Trim())
}

function Get-TableCellText {
    param(
        [System.Xml.XmlElement]$Table,
        [int]$RowIndex,
        [int]$ColumnIndex
    )

    $rows = @($Table.SelectNodes('./tbody/tr'))
    if ($RowIndex -ge $rows.Count) { return '' }
    $cells = @($rows[$RowIndex].SelectNodes('./td'))
    if ($ColumnIndex -ge $cells.Count) { return '' }
    return Get-NormalizedText $cells[$ColumnIndex]
}

try {
    $formal = Parse-Document (Read-DocumentContent $FormalContent) 'Formal document'
    $demo = Parse-Document (Read-DocumentContent $DemoContent) 'Demo document'

    $formalBlocks = @($formal.SelectNodes('./*'))
    $demoBlocks = @($demo.SelectNodes('./*'))
    if ($formalBlocks.Count -ne $demoBlocks.Count) {
        Add-CheckError "Top-level block count must match formal document: expected $($formalBlocks.Count), got $($demoBlocks.Count)"
    }
    $blockCount = [Math]::Min($formalBlocks.Count, $demoBlocks.Count)
    $tableOrdinal = 0
    for ($index = 0; $index -lt $blockCount; $index++) {
        $formalBlock = $formalBlocks[$index]
        $demoBlock = $demoBlocks[$index]
        if ($formalBlock.LocalName -ne $demoBlock.LocalName) {
            Add-CheckError "Top-level block $($index + 1) must be $($formalBlock.LocalName), got $($demoBlock.LocalName)"
            continue
        }
        if ($formalBlock.LocalName -eq 'table') { $tableOrdinal++ }
        $isDataVariableDiagnosisTable = $formalBlock.LocalName -eq 'table' -and $tableOrdinal -eq 5
        $isDirectionalDecisionTable = $formalBlock.LocalName -eq 'table' -and $tableOrdinal -eq 3 -and @($demoBlock.SelectNodes('.//td[3][contains(., "（方向性）")]')).Count -gt 0
        if (-not $isDataVariableDiagnosisTable -and -not $isDirectionalDecisionTable -and (Get-ShapeSignature $formalBlock) -ne (Get-ShapeSignature $demoBlock)) {
            Add-CheckError "Top-level block $($index + 1) ($($formalBlock.LocalName)) structure or formatting differs from formal document"
        }
    }

    $formalTables = @($formal.SelectNodes('./table'))
    $demoTables = @($demo.SelectNodes('./table'))
    if ($formalTables.Count -ne $demoTables.Count) {
        Add-CheckError "Table count must match formal document: expected $($formalTables.Count), got $($demoTables.Count)"
    }
    $tableCount = [Math]::Min($formalTables.Count, $demoTables.Count)
    for ($tableIndex = 0; $tableIndex -lt $tableCount; $tableIndex++) {
        $formalTable = $formalTables[$tableIndex]
        $demoTable = $demoTables[$tableIndex]
        $formalRows = @($formalTable.SelectNodes('./tbody/tr')).Count
        $demoRows = @($demoTable.SelectNodes('./tbody/tr')).Count
        if ($formalRows -ne $demoRows) {
            Add-CheckError "Table $($tableIndex + 1) body row count must match formal document: expected $formalRows, got $demoRows"
        }
        $formalHeaders = @($formalTable.SelectNodes('./thead/tr/th') | ForEach-Object { Get-NormalizedText $_ }) -join '|'
        $demoHeaders = @($demoTable.SelectNodes('./thead/tr/th') | ForEach-Object { Get-NormalizedText $_ }) -join '|'
        if ($formalHeaders -ne $demoHeaders) {
            Add-CheckError "Table $($tableIndex + 1) headers differ from formal document"
        }
        $formalBreaks = @($formalTable.SelectNodes('.//br')).Count
        $demoBreaks = @($demoTable.SelectNodes('.//br')).Count
        if ($tableIndex -ne 4 -and $formalBreaks -ne $demoBreaks) {
            Add-CheckError "Table $($tableIndex + 1) line-break count must match formal document: expected $formalBreaks, got $demoBreaks"
        }
    }

    $formalSummary = $formal.SelectSingleNode('./h1[normalize-space(.)="五、总结"]')
    $demoSummary = $demo.SelectSingleNode('./h1[normalize-space(.)="五、总结"]')
    if ($null -eq $formalSummary -or $null -eq $demoSummary) {
        Add-CheckError '五、总结 heading is missing from formal document or Demo'
    }
    else {
        $formalSummaryList = $formalSummary.SelectSingleNode('following-sibling::ol[1]')
        $demoSummaryList = $demoSummary.SelectSingleNode('following-sibling::ol[1]')
        $formalNested = @($formalSummaryList.SelectNodes('./li') | ForEach-Object { @($_.SelectNodes('./ol/li')).Count }) -join '/'
        $demoNested = @($demoSummaryList.SelectNodes('./li') | ForEach-Object { @($_.SelectNodes('./ol/li')).Count }) -join '/'
        if ($formalNested -ne $demoNested) {
            Add-CheckError "Summary nested list shape must match formal document: expected $formalNested, got $demoNested"
        }
    }

    $categoryTable = if ($demoTables.Count -ge 3) { $demoTables[2] } else { $null }
    if ($null -ne $categoryTable) {
        foreach ($rowIndex in 0..6) {
            $note = Get-TableCellText $categoryTable $rowIndex 4
            if ($note -notmatch '下载侧T2\+T3为' -or $note -notmatch '收入侧' -or $note -notmatch '收入数据覆盖率为') {
                Add-CheckError "Table 3 row $($rowIndex + 1) must explain download layer, income observation layer, and coverage"
            }
            $noteCell = @($categoryTable.SelectNodes('./tbody/tr'))[$rowIndex].SelectNodes('./td')[4]
            if (@($noteCell.SelectNodes('.//br')).Count -ne 2) {
                Add-CheckError "Table 3 row $($rowIndex + 1) must use two explicit line breaks in its decision note"
            }
        }
    }

    $expectedGroups = @('US', 'T1', 'T2', 'T3', 'IN观察组', '拉美观察组', '东南亚观察组')
    $diagnosisTable = if ($demoTables.Count -ge 5) { $demoTables[4] } else { $null }
    if ($null -ne $diagnosisTable) {
        $rows = @($diagnosisTable.SelectNodes('./tbody/tr'))
        for ($index = 0; $index -lt [Math]::Min($rows.Count, $expectedGroups.Count); $index++) {
            $actual = Get-NormalizedText @($rows[$index].SelectNodes('./td'))[0]
            if ($actual -ne $expectedGroups[$index]) {
                Add-CheckError "Table 5 row $($index + 1) group must be '$($expectedGroups[$index])', got '$actual'"
            }
        }
        $expectedNoteBreaks = @(1, 1, 1, 2, 2, 2, 3)
        for ($index = 0; $index -lt [Math]::Min($rows.Count, $expectedNoteBreaks.Count); $index++) {
            $noteCell = @($rows[$index].SelectNodes('./td'))[5]
            if ($null -eq $noteCell -or @($noteCell.SelectNodes('.//br')).Count -ne $expectedNoteBreaks[$index]) {
                Add-CheckError "Table 5 row $($index + 1) observation note must use $($expectedNoteBreaks[$index]) explicit line breaks"
            }
        }
    }
}
catch {
    Add-CheckError $_.Exception.Message
}

if ($errors.Count -gt 0) {
    Write-Output 'FORMAL_PARITY_CHECK: FAIL'
    $errors | Select-Object -Unique | ForEach-Object { Write-Output "- $_" }
    exit 1
}

Write-Output 'FORMAL_PARITY_CHECK: PASS'
