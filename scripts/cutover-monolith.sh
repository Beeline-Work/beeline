#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/cutover-monolith.sh --rollback --target-origin URL

Required cut environment is documented in apps/server/docs/cutover-monolith.md.
The one-time migration is complete; execute and rehearse are retired.
Rollback remains guarded by the recorded reopen boundary.
EOF
}

MODE=''
TARGET_ORIGIN=''
PRODUCTION_MONOLITH_ORIGIN='https://server.usebeeline.app'
while (($#)); do
  case "$1" in
    --execute) MODE='execute' ;;
    --rehearse) MODE='rehearse' ;;
    --rollback) MODE='rollback' ;;
    --target-origin) shift; TARGET_ORIGIN="${1:-}" ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$MODE" ]] || { usage >&2; exit 2; }
if [[ "$MODE" != rollback ]]; then
  echo "legacy workspace migration is complete; execute and rehearse are retired" >&2
  exit 2
fi
if [[ -z "$TARGET_ORIGIN" ]]; then
  TARGET_ORIGIN="$PRODUCTION_MONOLITH_ORIGIN"
fi
[[ -n "$TARGET_ORIGIN" ]] || { usage >&2; exit 2; }
[[ "$TARGET_ORIGIN" =~ ^https?://[^/]+$ ]] || {
  echo 'target origin must be an HTTP(S) origin without a path' >&2
  exit 2
}
STATE_ROOT="${CUTOVER_STATE_ROOT:-.cutover-state}"
mkdir -p "$STATE_ROOT"
TARGET_KEY="$(printf '%s' "$TARGET_ORIGIN" | sha256sum | cut -c1-16)"
STATE_FILE="$STATE_ROOT/monolith-${TARGET_KEY}.state"
touch "$STATE_FILE"

log() { printf '[cutover] %s\n' "$*"; }
die() { printf '[cutover] FAILED: %s\n' "$*" >&2; exit 1; }
done_step() { grep -Fxq "$1" "$STATE_FILE"; }
mark_step() { done_step "$1" || printf '%s\n' "$1" >> "$STATE_FILE"; }

run_hook() {
  local variable="$1" label="$2"
  local command_text="${!variable:-}"
  [[ -n "$command_text" ]] || die "$variable is required for $label"
  log "$label"
  bash -euo pipefail -c "$command_text"
}

rollback() {
  if done_step reopened; then
    die 'FORWARD-ONLY: writes reopened; old-stack rollback would fork data. Roll forward on the monolith.'
  fi
  log 'rollback before reopen: re-point clients to the old stack'
  run_hook CUTOVER_ROLLBACK_DAEMONS_COMMAND 'rollback: restore legacy daemon runtime transport'
  run_hook CUTOVER_ROLLBACK_OTA_COMMAND 'rollback: restore the old phone transport'
  run_hook CUTOVER_ROLLBACK_VERIFY_COMMAND 'rollback verify: old stack serves clients and remains the only writer'
  mark_step rolled-back
}

rollback
