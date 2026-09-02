$ErrorActionPreference = 'Stop'

$validator = Join-Path $PSScriptRoot 'verify-formal-parity.ps1'
$powerShell = (Get-Process -Id $PID).Path
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('.amda-formal-parity-test-' + [guid]::NewGuid().ToString('N'))

function Write-Utf8Text([string]$PathValue, [string]$Value) {
    [System.IO.File]::WriteAllText(
        $PathValue,
        $Value,
        (New-Object System.Text.UTF8Encoding($false))
    )
}

function Invoke-Validator([string]$FormalContent, [string]$DemoContent) {
    $formalPath = Join-Path $testRoot 'formal.xml'
    $demoPath = Join-Path $testRoot 'demo.xml'
    Write-Utf8Text $formalPath $FormalContent
    Write-Utf8Text $demoPath $DemoContent
    $savedErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 promotes native stderr to a terminating error
        # when the caller uses $ErrorActionPreference = 'Stop'. The negative
        # fixture must be captured so the validator's exit code can be checked.
        $ErrorActionPreference = 'Continue'
        # Passing XML containing commas directly to Windows PowerShell 5.1
        # can split native arguments; file-backed inputs keep the contract
        # identical across PowerShell editions.
        $output = & $powerShell -NoProfile -File $validator -FormalContent $formalPath -DemoContent $demoPath 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = @($output | ForEach-Object { [string]$_ })
    }
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null

    # Build the required Chinese heading from code points so the UTF-8 (no BOM)
    # test file parses identically under Windows PowerShell 5.1's system code page.
    $summaryHeading = ([char]0x4E94).ToString() + [char]0x3001 + [char]0x603B + [char]0x7ED3
    $suffix = "<h1>$summaryHeading</h1><ol><li><ol></ol></li></ol>"
    $formal = '<ol><li seq-marker="1. "><span background-color="rgb(247, 105, 100)">boundary</span></li></ol>' + $suffix
    $different = '<ol><li><span background-color="rgb(255, 0, 0)">boundary</span></li></ol>' + $suffix

    foreach ($alias in @('red', '#f54a45', 'rgb(245, 74, 69)', 'rgb(247, 105, 100)')) {
        $equivalent = "<ol><li><span background-color=`"$alias`">boundary</span></li></ol>" + $suffix
        $equivalentResult = Invoke-Validator $formal $equivalent
        if ($equivalentResult.ExitCode -ne 0 -or $equivalentResult.Output -notcontains 'FORMAL_PARITY_CHECK: PASS') {
            throw "Known Lark semantic red alias '$alias' must be equivalent: $($equivalentResult.Output -join '; ')"
        }
    }

    $differentResult = Invoke-Validator $formal $different
    if ($differentResult.ExitCode -eq 0 -or -not ($differentResult.Output -match 'structure or formatting differs')) {
        throw 'An unrelated red value must still fail formal parity'
    }

    Write-Output 'FORMAL_PARITY_TEST: PASS'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
