$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lark-style-semantics.ps1')

foreach ($alias in @('red', 'RED', '#f54a45', 'rgb(245, 74, 69)', 'rgb(247, 105, 100)')) {
    if (-not (Test-LarkSemanticRed $alias)) {
        throw "Known Lark semantic red alias '$alias' must be accepted"
    }
}

foreach ($different in @('', '#ff0000', 'rgb(255, 0, 0)', 'rgb(247, 105, 101)')) {
    if (Test-LarkSemanticRed $different) {
        throw "Unrelated color '$different' must not be accepted as Lark semantic red"
    }
}

Write-Output 'LARK_STYLE_SEMANTICS_TEST: PASS'
