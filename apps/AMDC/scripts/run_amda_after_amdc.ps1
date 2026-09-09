param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{8}-\d{6}-[a-f0-9]{4}$')]
  [string]$BatchId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
  [string]$WeekAnchor,

  [Parameter(Mandatory = $true)]
  [string]$RunDir,

  [string]$AmdcProjectDir = (Join-Path $PSScriptRoot '..'),
  [string]$AmdaProjectDir = (Join-Path $PSScriptRoot '..\..\..\skills\AMDA'),
  [string]$ConfigFile = '',
  [string]$CodexModel = '',
  [switch]$VerificationOnly,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Resolve-Directory([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
    throw "$Label does not exist: $PathValue"
  }
  return (Resolve-Path -LiteralPath $PathValue).Path
}

$AmdcProjectDir = Resolve-Directory $AmdcProjectDir 'AMDC project directory'
$AmdaProjectDir = Resolve-Directory $AmdaProjectDir 'AMDA project directory'
$PowerShellPath = (Get-Process -Id $PID).Path
if (-not $ConfigFile) { $ConfigFile = Join-Path $AmdcProjectDir 'amdc-config.json' }
if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
  throw "AMDC config file does not exist: $ConfigFile"
}
$ConfigFile = (Resolve-Path -LiteralPath $ConfigFile).Path

$LogDir = Join-Path $AmdcProjectDir 'logs'
$TriggerDir = Join-Path $LogDir 'amda-triggers'
New-Item -ItemType Directory -Force -Path $TriggerDir | Out-Null
$LogFile = Join-Path $LogDir 'amda-update.log'
$StateFile = Join-Path $TriggerDir "$BatchId.json"
$PromptFile = Join-Path $TriggerDir "$BatchId.prompt.txt"
$CodexLogFile = Join-Path $TriggerDir "$BatchId.codex.log"
$LastMessageFile = Join-Path $TriggerDir "$BatchId.last-message.md"
$DemoRegistryFile = Join-Path $TriggerDir "$BatchId.demo.json"
$FormalParityScript = Join-Path $AmdaProjectDir 'scripts\verify-formal-parity.ps1'
$DemoTargetVerifier = Join-Path $AmdaProjectDir 'scripts\verify-amda-demo-target.ps1'
$ExistingDemoAuditor = Join-Path $AmdaProjectDir 'scripts\verify-amda-existing-demo.ps1'
$FormalPublisher = Join-Path $AmdaProjectDir 'scripts\publish-formal-from-demo.ps1'
$FormalReadbackFile = Join-Path $AmdaProjectDir "output\charts\formal-readback-$BatchId.json"
$DemoCandidateFile = Join-Path $AmdaProjectDir "output\charts\demo-content-$BatchId.xml"
$DemoAfterFile = Join-Path $AmdaProjectDir "output\charts\demo-after-$BatchId.json"
$FormalAfterCoverFile = Join-Path $AmdaProjectDir "output\charts\formal-after-cover-$BatchId.json"
$PreParityResultFile = Join-Path $AmdaProjectDir "output\charts\pre-formal-parity-$BatchId.txt"
$PostParityResultFile = Join-Path $AmdaProjectDir "output\charts\post-formal-parity-$BatchId.txt"
$FormalPublisherLogFile = Join-Path $TriggerDir "$BatchId.formal-cover.log"
$DemoDate = Get-Date -Format 'yyyyMMdd'
$DemoTitle = "AM-Demo-$DemoDate"
$AmdaStartedAt = Get-Date
$FinalNotificationSent = $false

function Write-TriggerLog([string]$Message) {
  Add-Content -LiteralPath $LogFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
}

function Write-State([string]$Status, [string]$Detail = '') {
  $state = [ordered]@{
    batchId = $BatchId
    weekAnchor = $WeekAnchor
    source = 'scheduled'
    status = $Status
    detail = $Detail
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  [System.IO.File]::WriteAllText(
    $StateFile,
    ($state | ConvertTo-Json -Depth 4),
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Get-AmdaElapsedMs {
  return [int64]([math]::Max(0, ((Get-Date) - $AmdaStartedAt).TotalMilliseconds))
}

function Send-AmdaNotification([string]$Event, [int64]$DurationMs) {
  if ($script:FinalNotificationSent) {
    Write-TriggerLog "AMDA status notification skipped: final event already sent ($Event)"
    return
  }
  $script:FinalNotificationSent = $true
  $notifyScript = Join-Path $AmdcProjectDir 'scripts\notify.js'
  if (-not (Test-Path -LiteralPath $notifyScript -PathType Leaf) -or -not (Test-Path -LiteralPath $RunDir -PathType Container)) {
    Write-TriggerLog 'AMDA status notification skipped: notify script or AMDC history directory is missing'
    return
  }
  & node $notifyScript $RunDir '--event' $Event '--config' $ConfigFile '--duration-ms' ([string]$DurationMs) *> (Join-Path $TriggerDir "$BatchId.$Event.notify.log")
  if ($LASTEXITCODE -ne 0) { Write-TriggerLog "AMDA status notification failed: $Event, exit code $LASTEXITCODE" }
}

function Test-FormalParity {
  param(
    [string]$FormalPath,
    [string]$DemoPath,
    [string]$ResultPath
  )

  if (-not (Test-Path -LiteralPath $FormalParityScript -PathType Leaf)) {
    Write-TriggerLog "Formal parity validator is missing: $FormalParityScript"
    Set-Content -LiteralPath $ResultPath -Value @(
      'FORMAL_PARITY_CHECK: FAIL'
      '- validator script is missing'
    ) -Encoding UTF8
    return $false
  }
  $formalReadbackMissing = -not (Test-Path -LiteralPath $FormalPath -PathType Leaf)
  $demoReadbackMissing = -not (Test-Path -LiteralPath $DemoPath -PathType Leaf)
  if ($formalReadbackMissing -or $demoReadbackMissing) {
    if ($formalReadbackMissing -and $demoReadbackMissing) {
      $missingReason = 'formal and Demo readbacks are missing'
    }
    elseif ($formalReadbackMissing) {
      $missingReason = 'formal readback is missing'
    }
    else {
      $missingReason = 'Demo readback is missing'
    }
    Write-TriggerLog "Formal parity readback is missing: formal=$formalReadbackMissing demo=$demoReadbackMissing"
    Set-Content -LiteralPath $ResultPath -Value @(
      'FORMAL_PARITY_CHECK: FAIL'
      "- $missingReason"
    ) -Encoding UTF8
    return $false
  }

  $powerShell = (Get-Process -Id $PID).Path
  if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) {
    throw "Current PowerShell executable is unavailable: $powerShell"
  }
  & $powerShell -NoProfile -ExecutionPolicy Bypass -File $FormalParityScript -FormalContent $FormalPath -DemoContent $DemoPath *> $ResultPath
  $parityExitCode = $LASTEXITCODE
  Write-TriggerLog "Formal parity check completed: exit code $parityExitCode; result=$ResultPath"
  return $parityExitCode -eq 0
}

try {
  if (-not (Test-Path -LiteralPath $DemoTargetVerifier -PathType Leaf)) {
    throw "AMDA Demo target verifier is missing: $DemoTargetVerifier"
  }
  if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
    $existing = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$existing.status -eq 'started' -or
        ([string]$existing.status -eq 'completed' -and -not $VerificationOnly)) {
      Write-TriggerLog "Duplicate trigger skipped: batch $BatchId is already $($existing.status)"
      exit 0
    }
  }

  if ($VerificationOnly) {
    if (-not (Test-Path -LiteralPath $ExistingDemoAuditor -PathType Leaf)) {
      throw "AMDA existing Demo auditor is missing: $ExistingDemoAuditor"
    }
    if ($DryRun) {
      Write-State 'dry_run' 'Verification-only parameters and paths validated; audit was not started'
      Write-TriggerLog 'Verification-only DryRun completed; audit was not started'
      exit 0
    }

    Write-State 'started' 'Deterministic AMDA verification-only audit started'
    Write-TriggerLog "Starting deterministic AMDA verification-only audit: batch $BatchId"
    $auditRegistry = Get-Content -LiteralPath $DemoRegistryFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $auditTitle = [string]$auditRegistry.title
    & $PowerShellPath -NoProfile -ExecutionPolicy Bypass -File $ExistingDemoAuditor `
      -BatchId $BatchId `
      -ExpectedTitle $auditTitle `
      -RegistryFile $DemoRegistryFile `
      -AmdaProjectDir $AmdaProjectDir *> $CodexLogFile
    $auditExitCode = $LASTEXITCODE
    $auditText = if (Test-Path -LiteralPath $CodexLogFile -PathType Leaf) {
      Get-Content -LiteralPath $CodexLogFile -Raw -Encoding UTF8
    } else { '' }

    if ($auditExitCode -eq 0 -and $auditText -match 'AMDA_EXISTING_DEMO_AUDIT: PASS') {
      [System.IO.File]::WriteAllText(
        $LastMessageFile,
        "AMDA verification-only audit passed.`r`n`r`nAMDA_AUTOMATION_FINAL_OK",
        [System.Text.UTF8Encoding]::new($false)
      )
      Write-State 'completed' 'Deterministic AMDA verification-only audit passed'
      Write-TriggerLog 'Deterministic AMDA verification-only audit completed'
    } else {
      Write-State 'failed' "Deterministic AMDA verification-only audit failed with exit code $auditExitCode"
      Write-TriggerLog "Deterministic AMDA verification-only audit failed: exit code $auditExitCode"
    }
    Write-TriggerLog 'AMDA verification-only notification skipped'
    exit 0
  }

  $prompt = @"
This is an AMDA update triggered by a completed AMDC Windows scheduled batch.

Batch information:
- AMDC batch: $BatchId
- AMDC collection week: $WeekAnchor
- AMDC project: $AmdcProjectDir
- AMDA project: $AmdaProjectDir
- Verification-only recovery: $VerificationOnly

Run the AMDA workflow from $AmdaProjectDir. First read and strictly follow $AmdaProjectDir\SKILL.md, README.md, and every required reference file.

Hard boundaries for this run:
0. If 'Verification-only recovery' is True, this is a read-only clean-audit round for an existing completed Demo. The registry and populated Demo must already exist. Do not create a document, write or update any Demo block, regenerate data/tables/charts, or send notifications. Validate the registered target without -RequireEmpty, refresh the full API readback, run all validators against existing artifacts, re-export and inspect the five whiteboard previews, and return the final marker only if this round has no failed command or tool call. This rule overrides every create/write instruction below.
1. This is the unattended scheduled path. Create exactly one new Demo draft in the root of My Library for a new AMDC batch. During this Codex stage do not overwrite, delete, or modify the formal market analysis document. After the Demo write, full API readback, all validators, and all five visible whiteboard checks pass, end the final response with the exact marker AMDA_AUTOMATION_DEMO_READY. The parent PowerShell trigger will then run the deterministic formal publisher; do not cover the formal document or delete the Demo yourself.
   - The Demo title must be exactly: $DemoTitle (format AM-Demo-yyyyMMdd, using the scheduled run date)
   - The Demo registry file is: $DemoRegistryFile
   - The registry JSON must use exactly the keys 'batch', 'title', and 'url'. Write the created Demo URL to 'url'; never use 'demo_url', 'document_url', or another alias.
   - If the registry already contains a usable Demo URL for this batch, use that URL directly for a retry or resume. Do not search My Library or any other cloud location.
   - If the registry does not contain a usable Demo URL, create one new Demo immediately, capture the URL returned by the create operation, and immediately write that URL and title to the registry file.
   - From the moment the Demo URL is known, every Demo read, write, API readback, scheduled visual check, and retry in this run must use only that exact URL. Never call `drive files list`, search for documents, resolve another Demo, or create a second Demo for this batch.
   - Before the first body write, run & "$DemoTargetVerifier" -RegistryFile "$DemoRegistryFile" -ExpectedTitle "$DemoTitle" -ExpectedBatchId "$BatchId" -RequireEmpty. This verifier owns the exact registry-key, batch, absolute-URL, title, and bounded post-create checks; do not reimplement any registry or title validation with inline PowerShell. On a resume with existing body blocks, validate the same registered target without -RequireEmpty, inspect its current blocks, and use precise block updates instead of appending the full candidate again.
   - On a resume, inspect the current batch artifacts and failure detail before doing work. Reuse every data, table, chart, validator, API-readback, and preview artifact already proven valid. If the prior failure affected only a validator or preview tool, do not regenerate data or rewrite any Demo block; rerun only that read-only check, then run the full validator set against the existing API readback.
2. Write all charts and other local artifacts only under $AmdaProjectDir\output\charts. Do not write to any other output, artifacts, diagrams, tmp, or repository-root directory.
   - Before exporting a new workbook snapshot, if $AmdaProjectDir\output\charts\all-sheets-csv.json already exists, copy it to $AmdaProjectDir\output\charts\source-baseline-$BatchId.json. After the export, run `python $AmdaProjectDir\scripts\verify-source-drift.py --current $AmdaProjectDir\output\charts\all-sheets-csv.json --baseline $AmdaProjectDir\output\charts\source-baseline-$BatchId.json --output $AmdaProjectDir\output\charts\source-drift-$BatchId.json`. A WARN records historical backfill or correction and is non-blocking; do not hide it or treat a new weekly sheet as drift.
3. Use only the fixed workbook and formal document URLs from the AMDA private local resource configuration. Do not search for, invent, or substitute cloud document URLs.
4. Apply the scheduled-sheet rule automatically; do not ask the user for date confirmation and do not stop at the general manual date gate.
   - Read workbook sheet metadata first, then include every visible weekly sheet whose name is a date-formatted sheet name used by the workbook (including YYYYMMDD or YYYY-MM-DD forms).
   - Exclude hidden sheets, non-date sheets, and non-weekly sheets.
   - Analyze all included sheets. Use the latest included sheet date as the effective cutoff date.
   - With the bundled lark-cli, '--include-row-prefix' is a valueless boolean switch. Pass the flag by itself to 'sheets +csv-get'; never append 'true' or 'false' as a positional argument.
   - If no qualifying visible date-named weekly sheet exists, stop and report a precise failure; do not invent a sheet or create an incomplete Demo.
5. Do not start AMDC collection, Feishu synchronization, or any other real collection job. This trigger consumes only the completed AMDC scheduled-batch result.
6. The Demo must match the formal report contract in structure and visual language.
   - Use exactly five SVG whiteboards in this order and in these formal slots: 01-global.svg, 02-trend.svg, 03-category.svg, 04-countries.svg immediately after the h2 “分品类IAA重点国家”, and 05-regions.svg. Mermaid, img blocks, appended PNGs, and docs +media-insert are forbidden.
   - Use the exact seven h1 headings: “核心观点速读”, “数据范围与口径”, “一、全球分组概览：规模层与收入层分离”, “二、近期趋势与数据可信度”, “三、品类×分组结构：规模层与收入层分开看”, “四、组内国家诊断：国家用于解释分组稳定性”, “五、总结”. Use one h2 named “分品类IAA重点国家”.
   - “核心观点速读” is one native ordered list with five items. “数据范围与口径” is one native ordered list with three inline formulas and nested variable definitions. “五、总结” is one native ordered list with five top-level items, each containing a native nested ordered list.
   - Keep five tables with body row counts 4, 3, 7, 7, 7 and total width 820px. Use the fixed column contracts and explicitly set every header/body cell vertical-align=middle and every paragraph align=center before checking whether a whole column must be left aligned because of automatic wrapping.
   - Build category-country data once, filter to the fixed T2/T3 country-code set, and reuse the same five countries and shares for 04-countries.svg and the “分品类IAA重点国家” table. Use full country names in the document table and country diagnosis.
   - After exporting the fixed workbook to `$AmdaProjectDir\output\charts\all-sheets-csv.json`, run the canonical analyzer exactly with `python $AmdaProjectDir\scripts\analyze-amda.py --raw $AmdaProjectDir\output\charts\all-sheets-csv.json --output $AmdaProjectDir\output\charts\analysis-$BatchId.json`. Do not generate or paste an ad hoc analyzer into `output\charts`; the canonical analyzer must perform per-record Top5 normalization, use the fixed T2/T3 set for category-country rows, and apply the documented IAP layer rule.
   - Run `python $AmdaProjectDir\scripts\prepare-report-data.py --analysis $AmdaProjectDir\output\charts\analysis-$BatchId.json --output $AmdaProjectDir\output\charts\report-data-$BatchId.json`, then render the five approved SVGs from that report-data file. Do not substitute a second calculation path.
   - Before writing, save the formal-document API readback to $FormalReadbackFile and the complete candidate Demo XML to $DemoCandidateFile. Run verify-formal-parity.ps1 against those two files and save its complete output to $PreParityResultFile. Do not compare the formal document with the initial empty Demo readback, and do not write the Demo unless the candidate passes.
   - The candidate and API document content are XML fragments with multiple top-level blocks. Whenever inspecting them as XML, first wrap the fragment in one synthetic '<root>...</root>' element; never cast the bare fragment directly to [xml] or assume DocumentElement already exists.
   - Run the local data and document validators before writing and again after full API readback: verify-source-drift.py, verify-report-data.ps1, verify-chart-layout.ps1, verify-report-table-layout.ps1, verify-report-contract.ps1, verify-amda-document.ps1, verify-formal-parity.ps1, and verify-report-numeric-parity.py. Before writing, numeric parity and verify-amda-document.ps1 must use $DemoCandidateFile without `-RemoteReadback`; after the Demo write, they must use $DemoAfterFile with `-RemoteReadback`; after formal publication, the publisher must use verify-amda-document.ps1 with `-FormalDocument` and reject workflow text anywhere in the formal body (the validators accept both XML and API JSON). They must compare canonical analysis JSON, report-data JSON, all five SVG value labels, and all five Demo table bodies. After the write, save the full Demo API readback to $DemoAfterFile and the formal parity result to $PostParityResultFile. Export and inspect all five whiteboard previews. A successful write response alone is not completion.
   - This unattended scheduled path must not call Browser, Chrome, computer-use, Microsoft Edge, or any visible browser for an additional full-page rendering check. Its visual acceptance is the full API XML readback plus all validators and direct inspection of the five remotely exported whiteboard preview images with a local image-inspection tool. Browser unavailability is not a reason to retry a forbidden visible-browser check or to withhold the final marker after those scheduled checks pass.
   - Run every PowerShell validator in a fresh child PowerShell process and check that child's immediate exit code plus its PASS marker. Never use an inherited or stale `$LASTEXITCODE` from an earlier external command to classify a validator result. Do not define an Invoke-Validator helper, do not pass arguments through a positional [string[]] parameter, and do not build an inline validator batch. Invoke each validator child directly with its literal named parameters.
   - For each whiteboard preview, pass '--output' a path relative to $AmdaProjectDir (for example 'output\charts\whiteboard-previews-$BatchId\01.jpg'), run lark-cli with $AmdaProjectDir as the working directory, and verify that same path under $AmdaProjectDir. Do not mix the caller's current directory with the AMDA-relative output path. The CLI may return JPEG bytes even when a caller used a .png name; identify JPEG or PNG from the file signature, accept either supported image encoding, and inspect it with the local image tool. Never fail only because the filename extension differs from the actual JPEG/PNG encoding.
7. This trigger owns notifications and the formal publication step. Do not call notify.js from Codex, do not send start/progress/pending notifications, and do not wait for user confirmation. Only after the Demo write, full API readback, all validators, and all five visible whiteboard checks pass, end the final response with the exact marker AMDA_AUTOMATION_DEMO_READY. Do not delete the Demo. The parent trigger will use the same registered Demo URL and batch to update the existing formal document by precise block operations, preserve the formal title and existing whiteboard tokens, re-read and revalidate the formal document, and delete the Demo only after every post-cover check passes. If any Demo check fails, end without the marker and describe the failure.
8. This unattended run must not modify repository source, Skill instructions, references, templates, generators, validators, or tests. Validator failure is evidence to stop the run and report the exact mismatch; it is never permission to patch the validator or relax a contract. Runtime writes remain limited to $AmdaProjectDir\output\charts and the batch files under $TriggerDir.
9. Do not spawn or delegate sub-agents, threads, or isolated writer tasks. The unattended Codex process must perform the single registered Demo write and all readback checks itself.

If the Demo can be completed, run the AMDA data, chart, table, API readback, and scheduled visual checks, then report the Demo location and verified results. Do not wait for user confirmation or perform formal publication in this Codex stage.
"@

  Set-Content -LiteralPath $PromptFile -Value $prompt -Encoding UTF8
  $runKind = if ($VerificationOnly) { 'verification-only recovery' } else { 'Demo update' }
  Write-State 'started' "Codex AMDA $runKind started; source is fixed to scheduled"
  Write-TriggerLog "Starting AMDA $runKind`: batch $BatchId, collection week $WeekAnchor"

  if ($DryRun) {
    Write-State 'dry_run' 'Trigger parameters and paths validated; Codex was not started'
    Write-TriggerLog 'DryRun completed; Codex was not started'
    exit 0
  }

  $codex = (Get-Command codex.exe -ErrorAction Stop).Source
  $arguments = @(
    'exec',
    '--ephemeral',
    '--color', 'never',
    '-C', $AmdaProjectDir,
    '--add-dir', $AmdcProjectDir,
    '-s', 'danger-full-access',
    '-o', $LastMessageFile
  )
  if (-not [string]::IsNullOrWhiteSpace($CodexModel)) {
    $arguments += @('--model', $CodexModel.Trim())
  }
  $arguments += $prompt
  & $codex @arguments *> $CodexLogFile
  $exitCode = $LASTEXITCODE
  $finalMessage = if (Test-Path -LiteralPath $LastMessageFile -PathType Leaf) {
    Get-Content -LiteralPath $LastMessageFile -Raw -Encoding UTF8
  } else {
    ''
  }

  $preFormalParityPassed = $false
  if ($exitCode -eq 0) {
    $preFormalParityPassed = Test-FormalParity $FormalReadbackFile $DemoAfterFile $PreParityResultFile
  }

  $demoReady = $finalMessage -match 'AMDA_AUTOMATION_DEMO_READY' -or
    $finalMessage -match 'AMDA_AUTOMATION_FINAL_OK'
  $formalCoverPassed = $false
  if ($exitCode -eq 0 -and $preFormalParityPassed -and $demoReady) {
    if (-not (Test-Path -LiteralPath $FormalPublisher -PathType Leaf)) {
      Write-TriggerLog "Formal publisher is missing: $FormalPublisher"
    } else {
      & $PowerShellPath -NoProfile -ExecutionPolicy Bypass -File $FormalPublisher `
        -BatchId $BatchId `
        -DemoRegistryFile $DemoRegistryFile `
        -AmdaProjectDir $AmdaProjectDir `
        -ExpectedFormalTitle 'AppMagic市场分析' `
        -FormalAfterFile $FormalAfterCoverFile *> $FormalPublisherLogFile
      $publisherExitCode = $LASTEXITCODE
      $publisherText = if (Test-Path -LiteralPath $FormalPublisherLogFile -PathType Leaf) {
        Get-Content -LiteralPath $FormalPublisherLogFile -Raw -Encoding UTF8
      } else { '' }
      $formalCoverPassed = $publisherExitCode -eq 0 -and $publisherText -match 'AMDA_FORMAL_COVER_OK'
      Write-TriggerLog "Formal publisher completed: exit code $publisherExitCode; passed=$formalCoverPassed; see $FormalPublisherLogFile"
      if ($formalCoverPassed) {
        [System.IO.File]::WriteAllText(
          $LastMessageFile,
          (($finalMessage.TrimEnd()) + "`r`n`r`nFormal document cover and post-cover validation passed.`r`n`r`nAMDA_AUTOMATION_FINAL_OK"),
          [System.Text.UTF8Encoding]::new($false)
        )
      }
    }
  }

  if ($exitCode -ne 0) {
    Write-State 'failed' "Codex exit code $exitCode"
    Write-TriggerLog "AMDA update failed: Codex exit code $exitCode; see $CodexLogFile"
    $event = 'amda_update_failed'
  } elseif (-not $preFormalParityPassed) {
    Write-State 'failed' 'Formal parity gate failed before formal publication, after the full Demo API readback'
    Write-TriggerLog "AMDA update failed: Formal parity gate failed before formal publication; see $PreParityResultFile"
    $event = 'amda_update_failed'
  } elseif (-not $demoReady) {
    Write-State 'failed' 'Codex completed without the required Demo-ready verification marker'
    Write-TriggerLog "AMDA update failed: required Demo-ready marker is missing; see $LastMessageFile"
    $event = 'amda_update_failed'
  } elseif (-not $formalCoverPassed) {
    Write-State 'failed' 'Formal document cover or post-cover validation failed; Demo was retained'
    Write-TriggerLog "AMDA update failed: formal document publisher did not pass; see $FormalPublisherLogFile"
    $event = 'amda_update_failed'
  } else {
    Write-State 'completed' 'AMDA Demo validation, formal document cover, post-cover validation, and Demo deletion passed'
    Write-TriggerLog "AMDA formal publication process completed; see $LastMessageFile"
    $event = 'amda_update_complete'
  }

  if ($VerificationOnly) {
    Write-TriggerLog "AMDA verification-only notification skipped: $event"
  } else {
    Send-AmdaNotification $event (Get-AmdaElapsedMs)
  }
  exit 0
} catch {
  try {
    Write-State 'failed' $_.Exception.Message
    Write-TriggerLog "AMDA trigger error: $($_.Exception.Message)"
    if (-not $FinalNotificationSent -and -not $DryRun -and -not $VerificationOnly) {
      Send-AmdaNotification 'amda_update_failed' (Get-AmdaElapsedMs)
    }
  } catch {}
  exit 1
}
