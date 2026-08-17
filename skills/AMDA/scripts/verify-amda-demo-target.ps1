param(
    [Parameter(Mandatory = $true)]
    [string]$RegistryFile,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedTitle,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedBatchId,

    [switch]$RequireEmpty,

    [ValidateRange(1, 10)]
    [int]$MaxAttempts = 5,

    [ValidateRange(0, 30)]
    [int]$RetryDelaySeconds = 2,

    [string]$ReadbackFile = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RegistryFile -PathType Leaf)) {
    throw 'AMDA Demo registry file does not exist'
}
$registry = Get-Content -LiteralPath $RegistryFile -Raw -Encoding UTF8 | ConvertFrom-Json
$registryKeys = @($registry.PSObject.Properties.Name)
$expectedRegistryKeys = @('batch', 'title', 'url')
if ($registryKeys.Count -ne $expectedRegistryKeys.Count -or
    @($registryKeys | Where-Object { $_ -notin $expectedRegistryKeys }).Count -ne 0 -or
    @($expectedRegistryKeys | Where-Object { $_ -notin $registryKeys }).Count -ne 0) {
    throw "AMDA Demo registry must contain exactly these keys: $($expectedRegistryKeys -join ', ')"
}

$registeredBatchId = [string]$registry.batch
$registeredTitle = [string]$registry.title
$registeredUrl = [string]$registry.url
if ($registeredBatchId -ne $ExpectedBatchId) {
    throw 'AMDA Demo registry batch does not match the scheduled batch'
}
if ([string]::IsNullOrWhiteSpace($registeredUrl)) {
    throw 'AMDA Demo registry URL is missing'
}
$absoluteUri = $null
if (-not [System.Uri]::TryCreate($registeredUrl, [System.UriKind]::Absolute, [ref]$absoluteUri) -or
    $absoluteUri.Scheme -notin @('http', 'https')) {
    throw 'AMDA Demo registry URL must be an absolute HTTP(S) URL'
}
if ($registeredTitle -ne $ExpectedTitle) {
    throw 'AMDA Demo registry title does not match the scheduled title'
}

if ($ReadbackFile -and -not (Test-Path -LiteralPath $ReadbackFile -PathType Leaf)) {
    throw 'AMDA Demo readback fixture does not exist'
}

function Read-DemoPayload {
    if ($ReadbackFile) {
        return Get-Content -LiteralPath $ReadbackFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }

    $savedUpdateNotifier = $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER
    $savedSkillsNotifier = $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER
    try {
        $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'
        $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1'
        $raw = & lark-cli docs +fetch --as user --doc $registeredUrl --detail full --doc-format xml
        if ($LASTEXITCODE -ne 0) {
            throw 'Registered AMDA Demo readback failed'
        }
        return $raw | ConvertFrom-Json
    }
    finally {
        if ($null -ne $savedUpdateNotifier) { $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = $savedUpdateNotifier }
        else { Remove-Item Env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER -ErrorAction SilentlyContinue }
        if ($null -ne $savedSkillsNotifier) { $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = $savedSkillsNotifier }
        else { Remove-Item Env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER -ErrorAction SilentlyContinue }
    }
}

$lastTitleState = 'missing'
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
        $payload = Read-DemoPayload
        if (-not $payload.ok -or $null -eq $payload.data -or $null -eq $payload.data.document) {
            throw 'Registered AMDA Demo readback payload is invalid'
        }
    }
    catch {
        if ($attempt -lt $MaxAttempts) {
            if ($RetryDelaySeconds -gt 0) { Start-Sleep -Seconds $RetryDelaySeconds }
            continue
        }
        throw "Registered AMDA Demo readback failed after $MaxAttempts attempts"
    }

    $content = [string]$payload.data.document.content
    try {
        if ($content.TrimStart().StartsWith('<root')) { [xml]$document = $content }
        else { [xml]$document = '<root>' + $content + '</root>' }
    }
    catch {
        throw 'Registered AMDA Demo content is not valid XML'
    }

    $titleNodes = @($document.DocumentElement.SelectNodes('./title'))
    $actualTitle = if ($titleNodes.Count -eq 1) { $titleNodes[0].InnerText.Trim() } else { '' }
    if ($titleNodes.Count -eq 1 -and $actualTitle -eq $ExpectedTitle) {
        $bodyBlocks = @(
            $document.DocumentElement.ChildNodes |
                Where-Object {
                    $_.NodeType -eq [System.Xml.XmlNodeType]::Element -and
                    $_.LocalName -ne 'title'
                }
        )
        if ($RequireEmpty -and $bodyBlocks.Count -ne 0) {
            throw "Registered AMDA Demo must be empty before first write; body block count is $($bodyBlocks.Count)"
        }

        [pscustomobject]@{
            status = 'AMDA_DEMO_TARGET_OK'
            titleMatched = $true
            empty = $bodyBlocks.Count -eq 0
            bodyBlockCount = $bodyBlocks.Count
            attempt = $attempt
        } | ConvertTo-Json -Compress
        return
    }

    $lastTitleState = if ($titleNodes.Count -eq 1) { 'mismatch' } else { "node_count_$($titleNodes.Count)" }
    if ($attempt -lt $MaxAttempts -and $RetryDelaySeconds -gt 0) {
        Start-Sleep -Seconds $RetryDelaySeconds
    }
}

throw "Registered AMDA Demo title validation failed after $MaxAttempts attempts ($lastTitleState)"
