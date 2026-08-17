function Get-LarkSemanticColor {
    param([AllowEmptyString()][string]$Value)

    $normalized = ($Value -replace '\s+', '').ToLowerInvariant()
    if ($normalized -in @('red', '#f54a45', 'rgb(245,74,69)', 'rgb(247,105,100)')) {
        return 'lark-semantic-red'
    }
    return $normalized
}

function Test-LarkSemanticRed {
    param([AllowEmptyString()][string]$Value)

    return (Get-LarkSemanticColor $Value) -eq 'lark-semantic-red'
}
