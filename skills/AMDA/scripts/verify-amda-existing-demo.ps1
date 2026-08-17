param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{8}-\d{6}-[a-f0-9]{4}$')]
    [string]$BatchId,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedTitle,

    [Parameter(Mandatory = $true)]
    [string]$RegistryFile,

    [string]$AmdaProjectDir = (Join-Path $PSScriptRoot '..')
)

$ErrorActionPreference = 'Stop'
$AmdaProjectDir = (Resolve-Path -LiteralPath $AmdaProjectDir).Path
$ChartsDir = Join-Path $AmdaProjectDir 'output\charts'
$PowerShellPath = (Get-Process -Id $PID).Path
$PythonPath = (Get-Command python -ErrorAction Stop).Source
$TargetVerifier = Join-Path $PSScriptRoot 'verify-amda-demo-target.ps1'
$DemoReadback = Join-Path $ChartsDir "demo-after-$BatchId.json"
$FormalReadback = Join-Path $ChartsDir "formal-readback-$BatchId.json"
$Analysis = Join-Path $ChartsDir "analysis-$BatchId.json"
$ReportData = Join-Path $ChartsDir "report-data-$BatchId.json"
$SourceBaseline = Join-Path $ChartsDir "source-baseline-$BatchId.json"
$SourceCurrent = Join-Path $ChartsDir 'all-sheets-csv.json'
$PreviewRelativeDir = "output\charts\whiteboard-previews-$BatchId"
$PreviewAbsoluteDir = Join-Path $AmdaProjectDir $PreviewRelativeDir
$PreviewCheck = Join-Path $ChartsDir "whiteboard-visible-check-$BatchId.txt"

function Write-Utf8Text([string]$PathValue, [string]$Content) {
    [System.IO.File]::WriteAllText($PathValue, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-PowerShellValidator {
    param(
        [string]$Name,
        [string]$ScriptPath,
        [string[]]$ArgumentList,
        [string]$PassMarker
    )

    $lines = & $PowerShellPath -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @ArgumentList 2>&1
    $exitCode = $LASTEXITCODE
    $text = (@($lines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
    if ($exitCode -ne 0 -or $text -notmatch [regex]::Escape($PassMarker)) {
        throw "$Name validator failed"
    }
    Write-Output "${Name}: PASS"
}

function Invoke-PythonValidator {
    param(
        [string]$Name,
        [string]$ScriptPath,
        [string[]]$ArgumentList,
        [string]$PassMarker
    )

    $lines = & $PythonPath $ScriptPath @ArgumentList 2>&1
    $exitCode = $LASTEXITCODE
    $text = (@($lines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
    if ($exitCode -ne 0 -or $text -notmatch [regex]::Escape($PassMarker)) {
        throw "$Name validator failed"
    }
    Write-Output "${Name}: PASS"
}

function Invoke-LarkJsonReadback([string]$DocumentUrl) {
    $savedUpdateNotifier = $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER
    $savedSkillsNotifier = $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER
    try {
        $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'
        $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1'
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            $lines = & lark-cli docs +fetch --as user --doc $DocumentUrl --detail full --doc-format xml 2>&1
            $exitCode = $LASTEXITCODE
            $text = (@($lines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
            if ($exitCode -eq 0) {
                try {
                    $payload = $text | ConvertFrom-Json
                    if ($payload.ok -and $null -ne $payload.data.document) { return $text }
                }
                catch {}
            }
            if ($attempt -lt 5) { Start-Sleep -Seconds 2 }
        }
    }
    finally {
        if ($null -ne $savedUpdateNotifier) { $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = $savedUpdateNotifier }
        else { Remove-Item Env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER -ErrorAction SilentlyContinue }
        if ($null -ne $savedSkillsNotifier) { $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = $savedSkillsNotifier }
        else { Remove-Item Env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER -ErrorAction SilentlyContinue }
    }
    throw 'Registered AMDA Demo readback failed after 5 attempts'
}

function Export-WhiteboardPreview {
    param(
        [string]$WhiteboardToken,
        [string]$RelativePath
    )

    $savedUpdateNotifier = $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER
    $savedSkillsNotifier = $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER
    Push-Location -LiteralPath $AmdaProjectDir
    try {
        $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'
        $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1'
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            & lark-cli whiteboard +query --as user --whiteboard-token $WhiteboardToken --output_as image --output $RelativePath --overwrite *> $null
            if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $AmdaProjectDir $RelativePath) -PathType Leaf)) {
                return
            }
            if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
        }
    }
    finally {
        Pop-Location
        if ($null -ne $savedUpdateNotifier) { $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = $savedUpdateNotifier }
        else { Remove-Item Env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER -ErrorAction SilentlyContinue }
        if ($null -ne $savedSkillsNotifier) { $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = $savedSkillsNotifier }
        else { Remove-Item Env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER -ErrorAction SilentlyContinue }
    }
    throw 'Whiteboard preview export failed after 3 attempts'
}

$targetLines = & $PowerShellPath -NoProfile -ExecutionPolicy Bypass -File $TargetVerifier `
    -RegistryFile $RegistryFile `
    -ExpectedTitle $ExpectedTitle `
    -ExpectedBatchId $BatchId 2>&1
$targetExitCode = $LASTEXITCODE
$targetText = (@($targetLines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
if ($targetExitCode -ne 0 -or $targetText -notmatch 'AMDA_DEMO_TARGET_OK') {
    throw 'Registered AMDA Demo target validation failed'
}
Write-Output 'demo-target: PASS'

$registry = Get-Content -LiteralPath $RegistryFile -Raw -Encoding UTF8 | ConvertFrom-Json
$readbackText = Invoke-LarkJsonReadback ([string]$registry.url)
Write-Utf8Text $DemoReadback $readbackText

Invoke-PowerShellValidator -Name 'report-data' `
    -ScriptPath (Join-Path $PSScriptRoot 'verify-report-data.ps1') `
    -ArgumentList @('-Data', $ReportData) `
    -PassMarker 'REPORT_DATA_CHECK: PASS'
Invoke-PowerShellValidator -Name 'chart-layout' `
    -ScriptPath (Join-Path $PSScriptRoot 'verify-chart-layout.ps1') `
    -ArgumentList @('-InputDir', $ChartsDir) `
    -PassMarker 'CHART_LAYOUT_CHECK: PASS'
Invoke-PowerShellValidator -Name 'table-layout' `
    -ScriptPath (Join-Path $PSScriptRoot 'verify-report-table-layout.ps1') `
    -ArgumentList @('-Content', $DemoReadback) `
    -PassMarker 'REPORT_TABLE_LAYOUT_CHECK: PASS'
Invoke-PowerShellValidator -Name 'report-contract' `
    -ScriptPath (Join-Path $PSScriptRoot 'verify-report-contract.ps1') `
    -ArgumentList @('-Content', $DemoReadback, '-ExamplesPath', (Join-Path $AmdaProjectDir 'references\examples.md')) `
    -PassMarker 'REPORT_CONTRACT_CHECK: PASS'
Invoke-PowerShellValidator -Name 'document' `
    -ScriptPath (Join-Path $PSScriptRoot 'verify-amda-document.ps1') `
    -ArgumentList @('-Content', $DemoReadback, '-ExpectedTitle', $ExpectedTitle, '-RemoteReadback') `
    -PassMarker 'REPORT_DOCUMENT_CHECK: PASS'
Invoke-PowerShellValidator -Name 'formal-parity' `
    -ScriptPath (Join-Path $PSScriptRoot 'verify-formal-parity.ps1') `
    -ArgumentList @('-FormalContent', $FormalReadback, '-DemoContent', $DemoReadback) `
    -PassMarker 'FORMAL_PARITY_CHECK: PASS'
Invoke-PythonValidator -Name 'numeric-parity' `
    -ScriptPath (Join-Path $PSScriptRoot 'verify-report-numeric-parity.py') `
    -ArgumentList @('--analysis', $Analysis, '--report-data', $ReportData, '--demo', $DemoReadback, '--charts-dir', $ChartsDir) `
    -PassMarker 'REPORT_NUMERIC_PARITY: PASS'
Invoke-PythonValidator -Name 'source-drift' `
    -ScriptPath (Join-Path $PSScriptRoot 'verify-source-drift.py') `
    -ArgumentList @('--current', $SourceCurrent, '--baseline', $SourceBaseline, '--output', (Join-Path $ChartsDir "source-drift-audit-$BatchId.json")) `
    -PassMarker 'SOURCE_DRIFT_CHECK: PASS'

$readback = $readbackText | ConvertFrom-Json
[xml]$xml = '<root>' + [string]$readback.data.document.content + '</root>'
$whiteboards = @($xml.root.SelectNodes('./whiteboard'))
if ($whiteboards.Count -ne 5) { throw "Expected 5 whiteboards, got $($whiteboards.Count)" }

New-Item -ItemType Directory -Path $PreviewAbsoluteDir -Force | Out-Null
Add-Type -AssemblyName System.Drawing
$previewRows = [System.Collections.Generic.List[object]]::new()
for ($index = 0; $index -lt $whiteboards.Count; $index++) {
    $token = [string]$whiteboards[$index].GetAttribute('token')
    if ([string]::IsNullOrWhiteSpace($token)) { throw "Whiteboard $($index + 1) token is missing" }
    $relativeFile = '{0}\{1:D2}.png' -f $PreviewRelativeDir, ($index + 1)
    $absoluteFile = Join-Path $AmdaProjectDir $relativeFile
    Export-WhiteboardPreview -WhiteboardToken $token -RelativePath $relativeFile

    $item = Get-Item -LiteralPath $absoluteFile
    if ($item.Length -lt 1000) { throw "Whiteboard preview $($index + 1) is unexpectedly small" }
    $bytes = [System.IO.File]::ReadAllBytes($absoluteFile)
    $encoding = if ($bytes.Length -ge 8 -and $bytes[0] -eq 137 -and $bytes[1] -eq 80 -and $bytes[2] -eq 78 -and $bytes[3] -eq 71) {
        'PNG'
    }
    elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 255 -and $bytes[1] -eq 216 -and $bytes[2] -eq 255) {
        'JPEG'
    }
    else {
        throw "Whiteboard preview $($index + 1) is not a supported JPEG or PNG"
    }

    $image = [System.Drawing.Image]::FromFile($absoluteFile)
    try {
        if ($image.Width -lt 100 -or $image.Height -lt 100) {
            throw "Whiteboard preview $($index + 1) dimensions are unexpectedly small"
        }
        [void]$previewRows.Add([pscustomobject]@{
            index = $index + 1
            file = [System.IO.Path]::GetFileName($absoluteFile)
            encoding = $encoding
            bytes = $item.Length
            width = $image.Width
            height = $image.Height
        })
    }
    finally {
        $image.Dispose()
    }
}

$previewText = @(
    'WHITEBOARD_VISIBLE_CHECK: PASS'
    $previewRows | ForEach-Object { "PREVIEW_$($_.index) $($_.encoding) $($_.width)x$($_.height) bytes=$($_.bytes)" }
) -join [Environment]::NewLine
Write-Utf8Text $PreviewCheck $previewText
Write-Output 'whiteboard-previews: PASS'
Write-Output 'AMDA_EXISTING_DEMO_AUDIT: PASS'
