# log_utils.sh
# shellcheck shell=bash

################################################################################
# log_msg
#
# Purpose:
#   Standardized logging function for scripts. Logs messages with timestamps,
#   script names, PIDs, and severity levels to stdout and optionally to a file.
#
# Usage:
#   log_msg LEVEL MESSAGE [log_file]
#
# Arguments:
#   LEVEL     : Log severity (INFO, WARN, ERROR, DEBUG, etc.)
#   MESSAGE   : The text to log
#   log_file  : (optional) Path to log file; if omitted, uses LOG_FILE env var;
#               if empty or "none", logs only to stdout.
#
# Environment Variables:
#   LOG_FILE  : Default log file location (optional)
#
# Output Format:
#   2025-08-10T14:33:45-04:00 [myscript.sh:12345] INFO  Something happened
#
# Notes:
#   - All timestamps are ISO-8601 with timezone.
#   - Messages also go to the specified log file if given.
#   - Script name and PID help trace logs from multiple scripts/processes.
#
################################################################################
log_msg() {
  local level="$1"
  shift || return
  local message="$1"
  shift || true

  # Determine log file path: argument > LOG_FILE env var > none
  local log_path="${1:-${LOG_FILE:-}}"

  # ISO-8601 timestamp with timezone
  local timestamp
  timestamp="$(date -Is)"

  # Script name (basename of $0) and PID
  local script_name pid
  script_name="$(basename "$0")"
  pid="$$"

  # Final formatted log entry
  local entry
  entry="$timestamp [$script_name:$pid] $(printf '%-5s' "$level") $message"

  # Print to stdout
  echo "$entry"

  # Optional log file
  if [[ -n "$log_path" && "$log_path" != "none" ]]; then
    mkdir -p "$(dirname "$log_path")" 2>/dev/null || true
    echo "$entry" >>"$log_path"
  fi
}
