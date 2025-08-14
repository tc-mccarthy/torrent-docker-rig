# vpn_utils.sh
# shellcheck shell=bash

################################################################################
# check_vpn_protection
#
# Purpose:
#   Query NordVPN’s status endpoint and print "true" if the machine is protected
#   by the VPN, otherwise print "false".
#
# Behavior:
#   - Calls: https://web-api.nordvpn.com/v1/ips/info
#   - Parses `.protected` via jq
#   - Logs the raw JSON if a log path is set
#
# Usage:
#   VPN_STATUS="$(check_vpn_protection)"
#
# Arguments (optional):
#   status_url : URL to NordVPN status API
#                Default: https://web-api.nordvpn.com/v1/ips/info
#   log_path   : File path for debug logs
#                Default: /scripts/vpn-health-check.log
#                Pass "none" or empty to disable logging
#
# Output:
#   Prints either:
#     true  - VPN is active and `.protected` == true
#     false - Not protected, error, or unexpected response
#
################################################################################
check_vpn_protection() {
  local url="${1:-${VPN_STATUS_URL:-https://web-api.nordvpn.com/v1/ips/info}}"
  local log_path_default="/scripts/vpn-health-check.log"
  local log_path="${2:-${VPN_LOG_PATH:-$log_path_default}}"

  # Require curl and jq
  if ! command -v curl >/dev/null || ! command -v jq >/dev/null; then
    echo "false"
    return
  fi

  # Fetch status JSON
  local response
  if ! response="$(
    curl --silent --show-error --fail \
         --max-time 10 \
         --retry 2 --retry-delay 1 --retry-connrefused \
         "$url"
  )"; then
    echo "false"
    return
  fi

  # Parse and check
  local protected
  protected="$(echo "$response" | jq -r '.protected // empty' 2>/dev/null)"

  if [[ "$protected" == "true" ]]; then
    echo "true"
  else
    echo "false"
  fi
}
