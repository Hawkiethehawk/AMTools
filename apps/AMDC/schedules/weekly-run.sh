#!/usr/bin/env bash
# AMDC Weekly Run - Linux/WSL cron wrapper
# 用法: crontab -e 添加:
#   0 9 * * 1 /path/to/AMDC/schedules/weekly-run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="${AMDC_PROJECT_DIR:-$APP_ROOT}"
LOG_DIR="${PROJECT_DIR}/logs"
RETENTION_DAYS="${AMDC_LOG_RETENTION_DAYS:-30}"
PS_SCRIPT="${APP_ROOT}/scripts/run_amdc_weekly.ps1"

pick_powershell() {
  if [[ -n "${AMDC_POWERSHELL:-}" ]]; then
    printf '%s\n' "$AMDC_POWERSHELL"
  elif command -v pwsh >/dev/null 2>&1; then
    printf '%s\n' "pwsh"
  elif command -v pwsh.exe >/dev/null 2>&1; then
    printf '%s\n' "pwsh.exe"
  elif command -v powershell.exe >/dev/null 2>&1; then
    printf '%s\n' "powershell.exe"
  else
    return 1
  fi
}

path_for_powershell() {
  local ps_bin="$1"
  local input_path="$2"
  if [[ "$ps_bin" == *sh.exe ]] && command -v wslpath >/dev/null 2>&1; then
    wslpath -w "$input_path"
  else
    printf '%s\n' "$input_path"
  fi
}

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/amdc-$(date +%Y%m%d-%H%M%S).log"
if ! PS_BIN="$(pick_powershell)"; then
  echo "PowerShell 7 or Windows PowerShell 5.1 is required" >&2
  exit 1
fi
PS_MAJOR="$("$PS_BIN" -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.Major' 2>/dev/null | tr -d '\r')"
if [[ ! "$PS_MAJOR" =~ ^([6-9]|[1-9][0-9]+)$ && "$PS_MAJOR" != "5" ]]; then
  echo "AMDC_POWERSHELL must point to PowerShell 7+ or Windows PowerShell 5.1" >&2
  exit 1
fi
PS_PROJECT_DIR="$(path_for_powershell "$PS_BIN" "$PROJECT_DIR")"
PS_ENTRY="$(path_for_powershell "$PS_BIN" "$PS_SCRIPT")"

ARGS=("-NoProfile" "-ExecutionPolicy" "Bypass" "-File" "$PS_ENTRY" "-ProjectDir" "$PS_PROJECT_DIR")
[[ -n "${WEEK_ANCHOR:-}" ]] && ARGS+=("-WeekAnchor" "$WEEK_ANCHOR")
[[ "${FRESH:-0}" == "1" ]] && ARGS+=("-Fresh")
[[ "${LIST_ONLY:-0}" == "1" ]] && ARGS+=("-ListOnly")
[[ "${EXPORT_ONLY:-0}" == "1" ]] && ARGS+=("-ExportOnly")
[[ "${SKIP_EXCEL:-0}" == "1" ]] && ARGS+=("-SkipExcel")

{
  echo "=== AMDC Weekly Run ==="
  echo "Start: $(date)"
  echo "Project: $PROJECT_DIR"
  echo "PowerShell: $PS_BIN"
  set +e
  "$PS_BIN" "${ARGS[@]}"
  exit_code=$?
  set -e
  echo "Exit: $exit_code at $(date)"
  find "$LOG_DIR" -name "amdc-*.log" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
  exit "$exit_code"
} >> "$LOG_FILE" 2>&1
