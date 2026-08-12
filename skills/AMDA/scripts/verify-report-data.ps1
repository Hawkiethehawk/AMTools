param(
    [Parameter(Mandatory = $true)]
    [string]$Data
)

$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()

function Add-Error([string]$Message) {
    [void]$script:errors.Add($Message)
}

if (Test-Path -LiteralPath $Data -PathType Leaf) {
    $raw = Get-Content -LiteralPath $Data -Raw -Encoding UTF8
}
else {
    $raw = $Data
}

try {
    $report = $raw | ConvertFrom-Json
}
catch {
    throw "Report data is not valid JSON: $($_.Exception.Message)"
}

$required = @('global', 'trend', 'category', 'categoryCountries', 'regions')
foreach ($name in $required) {
    if ($null -eq $report.PSObject.Properties[$name]) {
        Add-Error "Missing top-level field '$name'"
    }
}

function Get-Number($Object, [string]$Property, [string]$Label) {
    if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Property]) {
        Add-Error "Missing numeric field $Label"
        return $null
    }
    $value = 0.0
    if (-not [double]::TryParse([string]$Object.PSObject.Properties[$Property].Value, [ref]$value)) {
        Add-Error "$Label is not numeric"
        return $null
    }
    if ($value -lt 0 -or $value -gt 100) {
        Add-Error "$Label is outside 0-100: $value"
    }
    return $value
}

if ($null -ne $report.global) {
    foreach ($side in @('download', 'income')) {
        $values = $report.global.PSObject.Properties[$side].Value
        $sum = 0.0
        $mainSum = 0.0
        foreach ($code in @('US', 'T1', 'T2', 'T3', 'other')) {
            $value = Get-Number $values $code "global.$side.$code"
            if ($null -ne $value) {
                $sum += $value
                if ($code -ne 'other') { $mainSum += $value }
            }
        }
        if ([math]::Abs($sum - 100) -gt 0.5) {
            Add-Error "global.$side must sum to 100, got $sum"
        }
        $other = if ($null -ne $values.PSObject.Properties['other']) { [double]$values.other } else { $null }
        if ($null -ne $other) {
            $expectedOther = [math]::Round(100.0 - $mainSum, 1)
            if ([math]::Abs($other - $expectedOther) -gt 0.11) {
                Add-Error "global.$side.other must close the rounded main-group sum, got $other, expected $expectedOther"
            }
        }
    }
}

if ($null -ne $report.trend) {
    $dates = @($report.trend.dates)
    if ($dates.Count -lt 2) { Add-Error 'trend.dates must contain at least two dates' }
    foreach ($key in @('downloadT3', 'incomeUSPlusT1', 'coverage')) {
        $values = @($report.trend.PSObject.Properties[$key].Value)
        if ($values.Count -ne $dates.Count) {
            Add-Error "trend.$key length must match trend.dates"
        }
        for ($index = 0; $index -lt $values.Count; $index++) {
            [void](Get-Number ([pscustomobject]@{ value = $values[$index] }) 'value' "trend.$key[$index]")
        }
    }
}

if ($null -ne $report.category) {
    $rows = @($report.category.rows)
    if ($rows.Count -ne 7) { Add-Error "category.rows must contain 7 rows, got $($rows.Count)" }
    foreach ($row in $rows) {
        foreach ($key in @('download', 'income', 'coverage')) {
            [void](Get-Number $row $key "category.$($row.name).$key")
        }
    }
}

$fixedIaaCodes = @(
    'AE','AT','BE','BR','CH','CL','CZ','EG','FI','GR','GU','HR','HU','IE','IL','IS','IT','KW','MO','MX','NG','PL','PR','QA','RU','SV','TH','TR','VI','ZA',
    'AF','AL','DZ','AS','AD','AO','AG','AR','AM','AW','AZ','BS','BH','BD','BB','BY','BZ','BJ','BM','BT','BO','BA','BW','BN','BG','BF','BI','KH','CM','CV','KY','CF','TD','CO','KM','CG','CD','CI','CU','DJ','DM','DO','EC','GQ','ET','FJ','GF','PF','GA','GM','GE','GH','GL','GD','GP','GT','GN','GW','GY','HT','HN','IN','ID','IR','IQ','JM','JO','KZ','KE','KI','KG','LA','LV','LB','LS','LR','LY','LT','LU','MK','MG','MW','MV','ML','MT','MQ','MR','MU','MF','MD','MN','ME','MA','MZ','MM','NA','NP','NC','NI','NE','OM','PK','PW','PS','PA','PG','PY','PE','PH','PT','RE','RO','RW','KN','LC','VC','SA','SN','RS','SC','SL','SK','SI','SB','SO','LK','SD','SR','SZ','SY','TJ','TL','TG','TT','TN','TM','TC','UG','UA','UY','UZ','VE','VN','VG','YE','ZM','ZW','SS','TZ','CW','FM','MP','SX','VU','MY'
)

if ($null -ne $report.categoryCountries) {
    $rows = @($report.categoryCountries.rows)
    if ($rows.Count -ne 7) { Add-Error "categoryCountries.rows must contain 7 rows, got $($rows.Count)" }
    foreach ($row in $rows) {
        $countries = @($row.countries)
        if ($countries.Count -ne 5) {
            Add-Error "categoryCountries.$($row.name) must contain five T2/T3 countries, got $($countries.Count)"
        }
        $seen = @{}
        $countrySum = 0.0
        foreach ($country in $countries) {
            $code = [string]$country.country
            if ($fixedIaaCodes -notcontains $code) { Add-Error "categoryCountries.$($row.name) contains non-T2/T3 code $code" }
            if ($seen.ContainsKey($code)) { Add-Error "categoryCountries.$($row.name) contains duplicate code $code" }
            $seen[$code] = $true
            $share = Get-Number $country 'share' "categoryCountries.$($row.name).$code.share"
            if ($null -ne $share) { $countrySum += $share }
        }
        $other = Get-Number $row 'other' "categoryCountries.$($row.name).other"
        if ($null -ne $other) {
            $countryTotal = $countrySum + $other
            if ([math]::Abs($countryTotal - 100) -gt 0.11) {
                Add-Error "categoryCountries.$($row.name) countries plus other must sum to 100, got $countryTotal"
            }
        }
    }
}

if ($null -ne $report.regions) {
    $rows = @($report.regions.rows)
    if ($rows.Count -ne 4) { Add-Error "regions.rows must contain 4 rows, got $($rows.Count)" }
    $names = @('US', 'IN', '拉美', '东南亚')
    for ($index = 0; $index -lt $rows.Count; $index++) {
        if ($index -lt $names.Count -and [string]$rows[$index].name -ne $names[$index]) {
            Add-Error "regions row $($index + 1) must be $($names[$index])"
        }
        [void](Get-Number $rows[$index] 'download' "regions.rows[$index].download")
        [void](Get-Number $rows[$index] 'income' "regions.rows[$index].income")
    }
}

if ($errors.Count -gt 0) {
    Write-Output 'REPORT_DATA_CHECK: FAIL'
    $errors | ForEach-Object { Write-Output "- $_" }
    exit 1
}

Write-Output 'REPORT_DATA_CHECK: PASS'
