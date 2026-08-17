$ErrorActionPreference = 'Stop'

$errors = [System.Collections.Generic.List[object]]::new()
$files = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File

foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$parseErrors
    ) | Out-Null
    foreach ($parseError in @($parseErrors)) {
        [void]$errors.Add([pscustomobject]@{
                File = $file.Name
                Line = $parseError.Extent.StartLineNumber
                Message = $parseError.Message
            })
    }
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error "$($_.File):$($_.Line): $($_.Message)" }
    exit 1
}

Write-Output "PowerShell syntax ok: $($files.Count) scripts"
