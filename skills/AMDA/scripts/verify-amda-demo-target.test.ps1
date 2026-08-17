$ErrorActionPreference = 'Stop'

$verifier = Join-Path $PSScriptRoot 'verify-amda-demo-target.ps1'
$powerShell = (Get-Process -Id $PID).Path
$chartsRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\output\charts'))
$testRoot = [System.IO.Path]::GetFullPath((Join-Path $chartsRoot ('.demo-target-test-' + [guid]::NewGuid().ToString('N'))))
if (-not $testRoot.StartsWith($chartsRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Demo target test directory escaped output\charts'
}

function Write-Utf8Json([string]$PathValue, [object]$Value) {
    [System.IO.File]::WriteAllText(
        $PathValue,
        ($Value | ConvertTo-Json -Depth 8),
        (New-Object System.Text.UTF8Encoding($false))
    )
}

function Invoke-TargetVerifier([string]$Registry, [string]$Readback, [switch]$RequireEmpty) {
    $arguments = @(
        '-NoProfile', '-File', $verifier,
        '-RegistryFile', $Registry,
        '-ExpectedTitle', 'AM-Demo-20300102',
        '-ExpectedBatchId', '20300102-010203-abcd',
        '-ReadbackFile', $Readback,
        '-MaxAttempts', '1',
        '-RetryDelaySeconds', '0'
    )
    if ($RequireEmpty) { $arguments += '-RequireEmpty' }
    $output = & $powerShell @arguments 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @($output | ForEach-Object { [string]$_ }) }
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $registryFile = Join-Path $testRoot 'registry.json'
    $emptyReadbackFile = Join-Path $testRoot 'empty.json'
    $wrongTitleFile = Join-Path $testRoot 'wrong-title.json'
    $nonEmptyFile = Join-Path $testRoot 'non-empty.json'
    $invalidPayloadFile = Join-Path $testRoot 'invalid-payload.json'

    $missingKeyRegistryFile = Join-Path $testRoot 'registry-missing-key.json'
    $extraKeyRegistryFile = Join-Path $testRoot 'registry-extra-key.json'
    $wrongBatchRegistryFile = Join-Path $testRoot 'registry-wrong-batch.json'
    $relativeUrlRegistryFile = Join-Path $testRoot 'registry-relative-url.json'

    Write-Utf8Json $registryFile @{ batch = '20300102-010203-abcd'; title = 'AM-Demo-20300102'; url = 'https://example.invalid/docx/test' }
    Write-Utf8Json $missingKeyRegistryFile @{ batch = '20300102-010203-abcd'; title = 'AM-Demo-20300102' }
    Write-Utf8Json $extraKeyRegistryFile @{ batch = '20300102-010203-abcd'; title = 'AM-Demo-20300102'; url = 'https://example.invalid/docx/test'; demo_url = 'https://example.invalid/docx/test' }
    Write-Utf8Json $wrongBatchRegistryFile @{ batch = '20300102-010203-ffff'; title = 'AM-Demo-20300102'; url = 'https://example.invalid/docx/test' }
    Write-Utf8Json $relativeUrlRegistryFile @{ batch = '20300102-010203-abcd'; title = 'AM-Demo-20300102'; url = '/docx/test' }
    Write-Utf8Json $emptyReadbackFile @{ ok = $true; data = @{ document = @{ content = '<title>AM-Demo-20300102</title>' } } }
    Write-Utf8Json $wrongTitleFile @{ ok = $true; data = @{ document = @{ content = '<title>AM-Demo-20300103</title>' } } }
    Write-Utf8Json $nonEmptyFile @{ ok = $true; data = @{ document = @{ content = '<title>AM-Demo-20300102</title><p>existing</p>' } } }
    Write-Utf8Json $invalidPayloadFile @{ ok = $false }

    $emptyResult = Invoke-TargetVerifier $registryFile $emptyReadbackFile -RequireEmpty
    if ($emptyResult.ExitCode -ne 0 -or -not ($emptyResult.Output -match 'AMDA_DEMO_TARGET_OK')) {
        throw "Matching empty Demo must pass: $($emptyResult.Output -join '; ')"
    }

    $wrongTitleResult = Invoke-TargetVerifier $registryFile $wrongTitleFile
    if ($wrongTitleResult.ExitCode -eq 0 -or -not ($wrongTitleResult.Output -match 'title validation failed')) {
        throw 'Mismatched Demo title must fail'
    }

    $nonEmptyResult = Invoke-TargetVerifier $registryFile $nonEmptyFile -RequireEmpty
    if ($nonEmptyResult.ExitCode -eq 0 -or -not ($nonEmptyResult.Output -match 'must be empty before first write')) {
        throw 'Non-empty Demo must fail the first-write guard'
    }

    $missingKeyResult = Invoke-TargetVerifier $missingKeyRegistryFile $emptyReadbackFile
    if ($missingKeyResult.ExitCode -eq 0 -or -not ($missingKeyResult.Output -match 'exactly these keys')) {
        throw 'Registry with a missing key must fail'
    }

    $extraKeyResult = Invoke-TargetVerifier $extraKeyRegistryFile $emptyReadbackFile
    if ($extraKeyResult.ExitCode -eq 0 -or -not ($extraKeyResult.Output -match 'exactly these keys')) {
        throw 'Registry with an extra key must fail'
    }

    $wrongBatchResult = Invoke-TargetVerifier $wrongBatchRegistryFile $emptyReadbackFile
    if ($wrongBatchResult.ExitCode -eq 0 -or -not ($wrongBatchResult.Output -match 'batch does not match')) {
        throw 'Registry for another batch must fail'
    }

    $relativeUrlResult = Invoke-TargetVerifier $relativeUrlRegistryFile $emptyReadbackFile
    if ($relativeUrlResult.ExitCode -eq 0 -or -not ($relativeUrlResult.Output -match 'absolute HTTP\(S\) URL')) {
        throw 'Registry with a relative URL must fail'
    }

    $readbackRetryArguments = @(
        '-NoProfile', '-File', $verifier,
        '-RegistryFile', $registryFile,
        '-ExpectedTitle', 'AM-Demo-20300102',
        '-ExpectedBatchId', '20300102-010203-abcd',
        '-ReadbackFile', $invalidPayloadFile,
        '-MaxAttempts', '2',
        '-RetryDelaySeconds', '0'
    )
    $readbackRetryOutput = & $powerShell @readbackRetryArguments 2>&1
    if ($LASTEXITCODE -eq 0 -or -not (@($readbackRetryOutput) -match 'readback failed after 2 attempts')) {
        throw 'Invalid Demo readback must exhaust the bounded retry before failing'
    }

    Write-Output 'AMDA_DEMO_TARGET_TEST: PASS'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
