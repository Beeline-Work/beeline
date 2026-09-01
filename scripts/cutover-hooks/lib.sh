#!/usr/bin/env bash

set -euo pipefail

HOOK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$HOOK_DIR/../.." && pwd -P)"
export REPO_ROOT

die() { printf 'cutover hook: %s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
need() { local value="${!1:-}"; [[ -n "$value" ]] || die "$1 is required"; }
expect_hex64() { [[ "$2" =~ ^[0-9a-f]{64}$ ]] || die "$1 must be 64 lowercase hex"; }
expect_https_origin() { [[ "$2" =~ ^https://[^/]+$ ]] || die "$1 must be an HTTPS origin without a path"; }
secure_file() {
  [[ -f "$2" ]] || die "$1 does not exist: $2"
  local mode
  mode="$(stat -c '%a' "$2")"
  (( (8#$mode & 077) == 0 )) || die "$1 must be mode 0600 (or stricter): $2"
}
runtime_path() {
  printf '%s/%s/runtime.json\n' "${CUTOVER_RUNTIME_ROOT:-$HOME/.local/state/beeline/agents}" "$1"
}
agent_ids() {
  need CUTOVER_AGENT_PUBKEYS
  local id
  for id in $CUTOVER_AGENT_PUBKEYS; do expect_hex64 CUTOVER_AGENT_PUBKEYS "$id"; printf '%s\n' "$id"; done
}
curl_code() {
  local output="$1"; shift
  curl --silent --show-error --max-time "${CUTOVER_HTTP_TIMEOUT_SECONDS:-20}" -o "$output" -w '%{http_code}' "$@"
}
token_from_file() {
  secure_file "$1" "$2"
  local token
  token="$(tr -d '\r\n' <"$2")"
  [[ ${#token} -ge 20 ]] || die "$1 does not contain a token"
  printf '%s\n' "$token"
}
