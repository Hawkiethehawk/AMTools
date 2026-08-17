$ErrorActionPreference = 'Stop'

$validator = Join-Path $PSScriptRoot 'verify-formal-parity.ps1'
$powerShell = (Get-Process -Id $PID).Path

function Invoke-Validator([string]$FormalContent, [string]$DemoContent) {
    $output = & $powerShell -NoProfile -File $validator -FormalContent $FormalContent -DemoContent $DemoContent 2>&1
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = @($output | ForEach-Object { [string]$_ })
    }
}

$suffix = '<h1>五、总结</h1><ol><li><ol></ol></li></ol>'
$formal = '<ol><li><span background-color="rgb(247, 105, 100)">边界</span></li></ol>' + $suffix
$different = '<ol><li><span background-color="rgb(255, 0, 0)">边界</span></li></ol>' + $suffix

foreach ($alias in @('red', '#f54a45', 'rgb(245, 74, 69)', 'rgb(247, 105, 100)')) {
    $equivalent = "<ol><li><span background-color=`"$alias`">边界</span></li></ol>" + $suffix
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
