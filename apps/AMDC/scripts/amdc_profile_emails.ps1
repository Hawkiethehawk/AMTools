param(
  [string]$ProjectDir = ".",
  [string]$Accounts = "",
  [switch]$AllowUnknown
)

$ErrorActionPreference = "Stop"
$ProjectDir = (Resolve-Path $ProjectDir).Path

function Get-CandidateProfiles {
  if ($Accounts) {
    return $Accounts.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  }
  Get-ChildItem -LiteralPath $ProjectDir -Force -Directory |
    Where-Object { $_.Name -match '^\.amdc-userdata(-.+)?$' } |
    Sort-Object Name |
    ForEach-Object { $_.Name }
}

function Normalize-Email([string]$Email) {
  $m = $Email.ToLowerInvariant()
  foreach ($suffix in @(".com", ".cn", ".net", ".org")) {
    $idx = $m.IndexOf($suffix)
    if ($idx -ge 0) { return $m.Substring(0, $idx + $suffix.Length) }
  }
  return $m
}

function Find-ProfileEmail([string]$Profile) {
  $root = Join-Path $ProjectDir $Profile
  if (-not (Test-Path -LiteralPath $root)) {
    return [pscustomobject]@{ Profile = $Profile; Email = ""; Status = "MISSING"; Count = 0 }
  }

  $counts = @{}
  Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -lt 20MB } |
    ForEach-Object {
      try {
        $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
        foreach ($enc in @([System.Text.Encoding]::UTF8, [System.Text.Encoding]::Unicode)) {
          $text = $enc.GetString($bytes)
          [regex]::Matches($text, '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}', 'IgnoreCase') |
            ForEach-Object {
              $email = Normalize-Email $_.Value
              if ($email -match '^[a-z0-9._%+-]+@[a-z0-9.-]+\.(com|cn|net|org)$' -and
                  $email -notmatch 'example|google|gstatic|sentry|schema|amdc') {
                if (-not $counts.ContainsKey($email)) { $counts[$email] = 0 }
                $counts[$email]++
              }
            }
        }
      } catch {}
    }

  if (-not $counts.Count) {
    return [pscustomobject]@{ Profile = $Profile; Email = ""; Status = "UNKNOWN"; Count = 0 }
  }
  $top = $counts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
  [pscustomobject]@{ Profile = $Profile; Email = $top.Key; Status = "OK"; Count = $top.Value }
}

$rows = @(Get-CandidateProfiles | ForEach-Object { Find-ProfileEmail $_ })
$groups = $rows | Where-Object { $_.Email } | Group-Object Email
$dupeEmails = @($groups | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
$unknownRows = @($rows | Where-Object { $_.Status -ne "OK" })

foreach ($row in $rows) {
  $duplicate = if ($row.Email -and ($dupeEmails -contains $row.Email)) { "DUPLICATE" } else { "" }
  [pscustomobject]@{
    Profile = $row.Profile
    Email = $row.Email
    Status = $row.Status
    Duplicate = $duplicate
  }
}

if ($dupeEmails.Count) {
  Write-Error ("Duplicate AMDC emails: " + ($dupeEmails -join ", "))
  exit 2
}
if ($unknownRows.Count -and -not $AllowUnknown) {
  Write-Error ("Unknown AMDC profile emails: " + (($unknownRows | ForEach-Object { $_.Profile }) -join ", "))
  exit 3
}
exit 0
