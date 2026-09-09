[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{8}-\d{6}-[a-f0-9]{4}$')]
  [string]$BatchId,

  [Parameter(Mandatory = $true)]
  [string]$DemoRegistryFile,

  [string]$AmdaProjectDir = (Join-Path $PSScriptRoot '..'),
  [string]$ExpectedFormalTitle = 'AppMagic市场分析',
  [string]$FormalAfterFile = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Resolve-Directory([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
    throw "$Label does not exist: $PathValue"
  }
  return (Resolve-Path -LiteralPath $PathValue).Path
}

function Read-JsonPath([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
    throw "$Label does not exist: $PathValue"
  }
  try {
    return (Get-Content -LiteralPath $PathValue -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    throw "$Label is not valid JSON: $($_.Exception.Message)"
  }
}

function Write-JsonPath([string]$PathValue, [object]$Value) {
  [System.IO.File]::WriteAllText(
    $PathValue,
    ($Value | ConvertTo-Json -Depth 12),
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Get-NormalizedDocumentContent([string]$RawContent) {
  try {
    [xml]$document = '<root>' + $RawContent + '</root>'
  } catch {
    throw "Formal document content is not valid XML: $($_.Exception.Message)"
  }
  foreach ($node in @($document.DocumentElement.SelectNodes('//*'))) {
    foreach ($attributeName in @('id', 'seq', 'seq-marker')) {
      if ($null -ne $node.Attributes[$attributeName]) {
        $node.RemoveAttribute($attributeName)
      }
    }
  }
  return [string]$document.DocumentElement.InnerXml
}

$AmdaProjectDir = Resolve-Directory $AmdaProjectDir 'AMDA project directory'
$DemoRegistryFile = (Resolve-Path -LiteralPath $DemoRegistryFile).Path
$OutputDir = Join-Path $AmdaProjectDir 'output\charts'
$CoverDir = Join-Path $OutputDir "formal-cover-$BatchId"
New-Item -ItemType Directory -Force -Path $CoverDir | Out-Null
if (-not $FormalAfterFile) {
  $FormalAfterFile = Join-Path $OutputDir "formal-after-cover-$BatchId.json"
}

$ResultFile = Join-Path $CoverDir 'result.json'
$FailureFile = Join-Path $CoverDir 'failure.json'
$PowerShellPath = (Get-Process -Id $PID).Path
$DemoTargetVerifier = Join-Path $AmdaProjectDir 'scripts\verify-amda-demo-target.ps1'
$DocumentVerifier = Join-Path $AmdaProjectDir 'scripts\verify-amda-document.ps1'
$TableVerifier = Join-Path $AmdaProjectDir 'scripts\verify-report-table-layout.ps1'
$ContractVerifier = Join-Path $AmdaProjectDir 'scripts\verify-report-contract.ps1'
$ParityVerifier = Join-Path $AmdaProjectDir 'scripts\verify-formal-parity.ps1'
$ReportDataVerifier = Join-Path $AmdaProjectDir 'scripts\verify-report-data.ps1'
$ChartLayoutVerifier = Join-Path $AmdaProjectDir 'scripts\verify-chart-layout.ps1'
$NumericParityVerifier = Join-Path $AmdaProjectDir 'scripts\verify-report-numeric-parity.py'
$ExamplesFile = Join-Path $AmdaProjectDir 'references\examples.md'
$AnalysisFile = Join-Path $OutputDir "analysis-$BatchId.json"
$ReportDataFile = Join-Path $OutputDir "report-data-$BatchId.json"

function Invoke-LarkJson {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$OutputName
  )

  $outputPath = Join-Path $CoverDir $OutputName
  & lark-cli @Arguments *> $outputPath
  $exitCode = $LASTEXITCODE
  $raw = if (Test-Path -LiteralPath $outputPath -PathType Leaf) {
    Get-Content -LiteralPath $outputPath -Raw -Encoding UTF8
  } else { '' }
  $jsonStart = $raw.IndexOf('{')
  if ($exitCode -ne 0 -or $jsonStart -lt 0) {
    throw "lark-cli failed for $OutputName with exit code $exitCode; see $outputPath"
  }
  try {
    $payload = $raw.Substring($jsonStart) | ConvertFrom-Json
  } catch {
    throw "lark-cli returned invalid JSON for ${OutputName}: $($_.Exception.Message)"
  }
  if (-not [bool]$payload.ok) {
    throw "lark-cli returned ok=false for $OutputName; see $outputPath"
  }
  return $payload
}

function Invoke-PowerShellCheck {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string[]]$Arguments,
    [string]$SuccessPattern = 'PASS'
  )

  $outputPath = Join-Path $CoverDir "$Name.log"
  & $PowerShellPath -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments *> $outputPath
  $exitCode = $LASTEXITCODE
  $text = if (Test-Path -LiteralPath $outputPath -PathType Leaf) {
    Get-Content -LiteralPath $outputPath -Raw -Encoding UTF8
  } else { '' }
  if ($exitCode -ne 0 -or $text -notmatch $SuccessPattern) {
    throw "formal cover validator failed: $Name; exit code $exitCode; see $outputPath"
  }
}

function Invoke-PythonCheck {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string[]]$Arguments,
    [string]$SuccessPattern = 'PASS'
  )

  $outputPath = Join-Path $CoverDir "$Name.log"
  & python $ScriptPath @Arguments *> $outputPath
  $exitCode = $LASTEXITCODE
  $text = if (Test-Path -LiteralPath $outputPath -PathType Leaf) {
    Get-Content -LiteralPath $outputPath -Raw -Encoding UTF8
  } else { '' }
  if ($exitCode -ne 0 -or $text -notmatch $SuccessPattern) {
    throw "formal cover validator failed: $Name; exit code $exitCode; see $outputPath"
  }
}

function Convert-DemoOpeningForFormal([System.Xml.XmlElement]$Block, [int]$Index) {
  if ($Index -ne 1 -or $Block.LocalName -ne 'p') {
    return
  }

  $reviewSuffix = '，供审校确认。确认前不会覆盖正式市场分析文档。'
  $textNodes = @($Block.SelectNodes('.//text()') | Where-Object { $_.Value.Contains('供审校确认') })
  if ($textNodes.Count -ne 1 -or -not $textNodes[0].Value.Contains($reviewSuffix)) {
    throw 'Demo opening block does not contain the expected review-only suffix'
  }
  $textNodes[0].Value = $textNodes[0].Value.Replace($reviewSuffix, '。')
  if ($Block.InnerText -match '供审校确认|确认前不会覆盖正式市场分析文档') {
    throw 'Formal opening still contains the review-only disclaimer'
  }
}

function Invoke-DocsUpdate {
  param(
    [string]$Command,
    [string]$BlockId,
    [string]$ContentArgument = ''
  )

  $script:OperationNumber++
  $name = "update-{0:D3}-{1}.json" -f $script:OperationNumber, $Command
  $arguments = @(
    'docs', '+update', '--as', 'user', '--doc', $script:FormalUrl,
    '--command', $Command, '--block-id', $BlockId, '--revision-id', '-1', '--format', 'json'
  )
  if ($Command -in @('block_replace', 'block_insert_after')) {
    $arguments += @('--content', $ContentArgument)
  }
  $oldLocation = Get-Location
  try {
    Set-Location $AmdaProjectDir
    $payload = Invoke-LarkJson $arguments $name
  } finally {
    Set-Location $oldLocation
  }
  if ([string]$payload.data.result -ne 'success') {
    throw "formal document update was not successful: $Command $BlockId"
  }
}

function Test-CompletedFormalResult([object]$PreviousResult) {
  if ([string]$PreviousResult.formalTitle -ne $ExpectedFormalTitle) {
    throw 'Completed formal cover result has an unexpected formal title'
  }
  if ($null -eq $PreviousResult.formalRevision) {
    throw 'Completed formal cover result does not record a formal revision'
  }
  if (-not (Test-Path -LiteralPath $FormalAfterFile -PathType Leaf)) {
    throw 'Completed formal cover result is missing its formal readback evidence'
  }

  $previousFormalPayload = Read-JsonPath $FormalAfterFile 'previous formal readback'
  $previousContent = [string]$previousFormalPayload.data.document.content
  if ([string]::IsNullOrWhiteSpace($previousContent)) {
    throw 'Previous formal readback does not contain document content'
  }

  $currentFormalPayload = Invoke-LarkJson @(
    'docs', '+fetch', '--as', 'user', '--doc', $script:FormalUrl,
    '--detail', 'full', '--format', 'json'
  ) 'formal-recheck.json'
  $currentFormalFile = Join-Path $CoverDir 'formal-recheck.json'
  Write-JsonPath $currentFormalFile $currentFormalPayload
  $currentContent = [string]$currentFormalPayload.data.document.content
  if ([string]::IsNullOrWhiteSpace($currentContent)) {
    throw 'Formal recheck does not contain document content'
  }
  if ([int64]$currentFormalPayload.data.document.revision_id -lt [int64]$PreviousResult.formalRevision) {
    throw 'Formal document revision regressed after the completed cover'
  }

  Invoke-PowerShellCheck 'formal-document-recheck' $DocumentVerifier @(
    '-Content', $currentFormalFile, '-ExpectedTitle', $ExpectedFormalTitle,
    '-RemoteReadback', '-FormalDocument'
  )
  if ((Get-NormalizedDocumentContent $currentContent) -ne (Get-NormalizedDocumentContent $previousContent)) {
    throw 'Formal document drifted after the completed cover; refusing cached success'
  }
  Write-Output 'AMDA_FORMAL_COVER_OK'
}

try {
  $registry = Read-JsonPath $DemoRegistryFile 'Demo registry'
  if ([string]$registry.batch -ne $BatchId) {
    throw "Demo registry batch does not match: expected $BatchId"
  }
  if ([string]::IsNullOrWhiteSpace([string]$registry.title) -or
      [string]::IsNullOrWhiteSpace([string]$registry.url)) {
    throw 'Demo registry must contain non-empty batch, title, and url'
  }
  $demoTitle = [string]$registry.title
  $demoUrl = [string]$registry.url
  $demoUri = [System.Uri]$demoUrl
  if (-not $demoUri.IsAbsoluteUri -or $demoUri.Scheme -notin @('http', 'https')) {
    throw 'Demo registry url is not an absolute http(s) URL'
  }

  $configPath = $env:AM_MARKET_ANALYTICS_CONFIG
  if ([string]::IsNullOrWhiteSpace($configPath)) {
    $configPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'am-market-analytics\resources.json'
  }
  $resourceConfig = Read-JsonPath $configPath 'AMDA local resource configuration'
  $script:FormalUrl = [string]$resourceConfig.formal_document.url
  if ([string]::IsNullOrWhiteSpace($script:FormalUrl)) {
    throw 'AMDA local resource configuration is missing formal_document.url'
  }

  if (Test-Path -LiteralPath $ResultFile -PathType Leaf) {
    $previous = Read-JsonPath $ResultFile 'formal cover result'
    if ([string]$previous.status -eq 'completed' -and
        [string]$previous.batchId -eq $BatchId -and
        [bool]$previous.demoDeleted) {
      Test-CompletedFormalResult $previous
      exit 0
    }
  }

  $demoTargetArguments = @(
    '-RegistryFile', $DemoRegistryFile,
    '-ExpectedTitle', $demoTitle,
    '-ExpectedBatchId', $BatchId
  )
  Invoke-PowerShellCheck 'demo-target' $DemoTargetVerifier $demoTargetArguments 'AMDA_DEMO_TARGET_OK'

  $demoPayload = Invoke-LarkJson @('docs', '+fetch', '--as', 'user', '--doc', $demoUrl, '--detail', 'full', '--format', 'json') 'demo-before-fetch.json'
  $demoDocument = $demoPayload.data.document
  if ($null -eq $demoDocument -or [string]::IsNullOrWhiteSpace([string]$demoDocument.content)) {
    throw 'Demo API readback did not contain document content'
  }
  $DemoBeforeFile = Join-Path $CoverDir 'demo-before-cover.json'
  Write-JsonPath $DemoBeforeFile $demoPayload

  $formalPayload = Invoke-LarkJson @('docs', '+fetch', '--as', 'user', '--doc', $script:FormalUrl, '--detail', 'full', '--format', 'json') 'formal-before-fetch.json'
  $formalDocument = $formalPayload.data.document
  if ($null -eq $formalDocument -or [string]::IsNullOrWhiteSpace([string]$formalDocument.content)) {
    throw 'formal API readback did not contain document content'
  }
  $FormalBeforeFile = Join-Path $CoverDir 'formal-before-cover.json'
  Write-JsonPath $FormalBeforeFile $formalPayload

  Invoke-PowerShellCheck 'demo-document-before' $DocumentVerifier @('-Content', $DemoBeforeFile, '-ExpectedTitle', $demoTitle, '-RemoteReadback')
  Invoke-PowerShellCheck 'demo-table-layout-before' $TableVerifier @('-Content', $DemoBeforeFile)
  Invoke-PowerShellCheck 'demo-report-contract-before' $ContractVerifier @('-Content', $DemoBeforeFile, '-ExamplesPath', $ExamplesFile)
  Invoke-PowerShellCheck 'report-data-before' $ReportDataVerifier @('-Data', $ReportDataFile)
  Invoke-PowerShellCheck 'chart-layout-before' $ChartLayoutVerifier @('-InputDir', $OutputDir)
  Invoke-PythonCheck 'numeric-parity-before' $NumericParityVerifier @('--analysis', $AnalysisFile, '--report-data', $ReportDataFile, '--demo', $DemoBeforeFile, '--charts-dir', $OutputDir)
  Invoke-PowerShellCheck 'formal-parity-before' $ParityVerifier @('-FormalContent', $FormalBeforeFile, '-DemoContent', $DemoBeforeFile)

  [xml]$formalXml = '<root>' + [string]$formalDocument.content + '</root>'
  [xml]$demoXml = '<root>' + [string]$demoDocument.content + '</root>'
  $formalNodes = @($formalXml.root.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })
  $demoNodes = @($demoXml.root.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })
  if ($formalNodes.Count -ne $demoNodes.Count) {
    throw "Formal and Demo top-level block counts differ: $($formalNodes.Count) vs $($demoNodes.Count)"
  }
  if ($formalNodes[0].LocalName -ne 'title' -or $formalNodes[0].InnerText.Trim() -ne $ExpectedFormalTitle) {
    throw 'Formal title block is not the protected expected title'
  }

  $coverBlocks = Join-Path $CoverDir 'blocks'
  New-Item -ItemType Directory -Force -Path $coverBlocks | Out-Null
  $blockReplacements = @()
  $listReplacements = @()
  $whiteboards = @()
  $svgNames = @('01-global.svg', '02-trend.svg', '03-category.svg', '04-countries.svg', '05-regions.svg')
  $whiteboardIndex = 0
  for ($index = 1; $index -lt $formalNodes.Count; $index++) {
    $formalNode = $formalNodes[$index]
    $demoNode = $demoNodes[$index]
    if ($formalNode.LocalName -ne $demoNode.LocalName) {
      throw "Formal and Demo block types differ at index $index"
    }
    if ($formalNode.LocalName -eq 'whiteboard') {
      $whiteboardIndex++
      $formalToken = $formalNode.GetAttribute('token')
      if ([string]::IsNullOrWhiteSpace($formalToken)) {
        throw "Formal whiteboard token is missing at index $index"
      }
      $svgPath = Join-Path $OutputDir $svgNames[$whiteboardIndex - 1]
      if (-not (Test-Path -LiteralPath $svgPath -PathType Leaf)) {
        throw "Approved SVG is missing: $svgPath"
      }
      $whiteboards += [ordered]@{
        index = $index
        token = $formalToken
        svg = $svgNames[$whiteboardIndex - 1]
      }
      continue
    }

    $copy = $demoNode.CloneNode($true)
    foreach ($node in @($copy.SelectNodes('//*[@id]'))) {
      $node.RemoveAttribute('id')
    }
    if ($copy.HasAttribute('id')) {
      $copy.RemoveAttribute('id')
    }
    Convert-DemoOpeningForFormal $copy $index
    $blockFile = Join-Path $coverBlocks ("block-{0:D2}.xml" -f ($blockReplacements.Count + $listReplacements.Count + 1))
    [System.IO.File]::WriteAllText($blockFile, $copy.OuterXml, (New-Object System.Text.UTF8Encoding($false)))
    $relativeBlockFile = $blockFile.Substring($AmdaProjectDir.Length + 1)

    if ($formalNode.LocalName -in @('ol', 'ul') -and [string]::IsNullOrWhiteSpace($formalNode.GetAttribute('id'))) {
      $deleteIds = @($formalNode.ChildNodes | Where-Object { $_.LocalName -eq 'li' } | ForEach-Object { $_.GetAttribute('id') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
      $anchorId = if ($index -gt 0) { $formalNodes[$index - 1].GetAttribute('id') } else { '' }
      if ($deleteIds.Count -eq 0 -or [string]::IsNullOrWhiteSpace($anchorId)) {
        throw "Formal list cannot be safely replaced at index $index"
      }
      $listReplacements += [ordered]@{
        index = $index
        deleteIds = $deleteIds
        anchorId = $anchorId
        file = $relativeBlockFile
      }
    } else {
      $formalBlockId = $formalNode.GetAttribute('id')
      if ([string]::IsNullOrWhiteSpace($formalBlockId)) {
        throw "Formal block id is missing at index $index"
      }
      $blockReplacements += [ordered]@{
        index = $index
        blockId = $formalBlockId
        file = $relativeBlockFile
      }
    }
  }
  if ($whiteboards.Count -ne 5) {
    throw "Expected exactly five formal whiteboards, got $($whiteboards.Count)"
  }

  if ($DryRun) {
    Write-Output 'AMDA_FORMAL_COVER_DRY_RUN_OK'
    exit 0
  }

  $script:OperationNumber = 0
  foreach ($list in $listReplacements) {
    Invoke-DocsUpdate 'block_delete' ($list.deleteIds -join ',')
    Invoke-DocsUpdate 'block_insert_after' $list.anchorId ('@' + $list.file)
  }
  $listIndexes = @($listReplacements | ForEach-Object { [int]$_.index })
  $anchorIndexes = @($listReplacements | ForEach-Object { [int]$_.index - 1 })
  foreach ($block in $blockReplacements) {
    if ($anchorIndexes -contains [int]$block.index) {
      continue
    }
    Invoke-DocsUpdate 'block_replace' $block.blockId ('@' + $block.file)
  }
  foreach ($block in $blockReplacements) {
    if ($anchorIndexes -contains [int]$block.index) {
      Invoke-DocsUpdate 'block_replace' $block.blockId ('@' + $block.file)
    }
  }

  $oldLocation = Get-Location
  try {
    Set-Location $AmdaProjectDir
    $whiteboardIndex = 0
    foreach ($whiteboard in $whiteboards) {
      $whiteboardIndex++
      $previewDir = Join-Path $OutputDir "formal-cover-previews-$BatchId"
      New-Item -ItemType Directory -Force -Path $previewDir | Out-Null
      $sourcePath = 'output\charts\' + $whiteboard.svg
      $previewPath = "output\charts\formal-cover-previews-$BatchId\$($whiteboardIndex.ToString('D2')).png"
      $updateArgs = @(
        'whiteboard', '+update', '--as', 'user', '--whiteboard-token', $whiteboard.token,
        '--input_format', 'svg', '--source', ('@' + $sourcePath), '--overwrite',
        '--idempotent-token', ("amda-cover-$BatchId-" + $whiteboardIndex.ToString('D2')), '--format', 'json'
      )
      $null = Invoke-LarkJson $updateArgs ("whiteboard-update-{0:D2}.json" -f $whiteboardIndex)
      $queryArgs = @(
        'whiteboard', '+query', '--as', 'user', '--whiteboard-token', $whiteboard.token,
        '--output_as', 'image', '--output', $previewPath, '--overwrite', '--format', 'json'
      )
      $null = Invoke-LarkJson $queryArgs ("whiteboard-preview-{0:D2}.json" -f $whiteboardIndex)
      $pngPath = Join-Path $AmdaProjectDir $previewPath
      $jpgPath = [System.IO.Path]::ChangeExtension($pngPath, '.jpg')
      $actualPreview = if (Test-Path -LiteralPath $pngPath) { $pngPath } elseif (Test-Path -LiteralPath $jpgPath) { $jpgPath } else { '' }
      if ([string]::IsNullOrWhiteSpace($actualPreview) -or (Get-Item -LiteralPath $actualPreview).Length -le 0) {
        throw "Formal whiteboard preview is missing or empty: $whiteboardIndex"
      }
    }
  } finally {
    Set-Location $oldLocation
  }

  $formalAfterPayload = Invoke-LarkJson @('docs', '+fetch', '--as', 'user', '--doc', $script:FormalUrl, '--detail', 'full', '--format', 'json') 'formal-after-fetch.json'
  Write-JsonPath $FormalAfterFile $formalAfterPayload

  Invoke-PowerShellCheck 'formal-document-after' $DocumentVerifier @('-Content', $FormalAfterFile, '-ExpectedTitle', $ExpectedFormalTitle, '-RemoteReadback', '-FormalDocument')
  Invoke-PowerShellCheck 'formal-table-layout-after' $TableVerifier @('-Content', $FormalAfterFile)
  Invoke-PowerShellCheck 'formal-report-contract-after' $ContractVerifier @('-Content', $FormalAfterFile, '-ExamplesPath', $ExamplesFile)
  Invoke-PowerShellCheck 'formal-parity-after' $ParityVerifier @('-FormalContent', $FormalAfterFile, '-DemoContent', $DemoBeforeFile)
  Invoke-PowerShellCheck 'report-data-after' $ReportDataVerifier @('-Data', $ReportDataFile)
  Invoke-PowerShellCheck 'chart-layout-after' $ChartLayoutVerifier @('-InputDir', $OutputDir)
  Invoke-PythonCheck 'numeric-parity-after' $NumericParityVerifier @('--analysis', $AnalysisFile, '--report-data', $ReportDataFile, '--demo', $DemoBeforeFile, '--charts-dir', $OutputDir)

  $inspect = Invoke-LarkJson @('drive', '+inspect', '--as', 'user', '--url', $demoUrl, '--format', 'json') 'demo-inspect.json'
  $demoToken = [string]$inspect.data.token
  $demoType = [string]$inspect.data.type
  if ([string]::IsNullOrWhiteSpace($demoToken) -or $demoType -ne 'docx') {
    throw 'Registered Demo target is not a deletable docx resource'
  }
  $deleted = Invoke-LarkJson @('drive', '+delete', '--as', 'user', '--file-token', $demoToken, '--type', $demoType, '--yes', '--format', 'json') 'demo-delete.json'
  if (-not [bool]$deleted.data.deleted) {
    throw 'Formal validation passed but Demo deletion was not confirmed'
  }

  $result = [ordered]@{
    status = 'completed'
    batchId = $BatchId
    formalTitle = $ExpectedFormalTitle
    formalRevision = [int64]$formalAfterPayload.data.document.revision_id
    demoTitle = $demoTitle
    demoDeleted = $true
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  Write-JsonPath $ResultFile $result
  Write-Output 'AMDA_FORMAL_COVER_OK'
} catch {
  $failure = [ordered]@{
    status = 'failed'
    batchId = $BatchId
    error = $_.Exception.Message
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  try { Write-JsonPath $FailureFile $failure } catch {}
  throw
}
