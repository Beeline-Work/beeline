#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/cutover-monolith.sh --execute [--target-origin https://server.usebeeline.app]
  scripts/cutover-monolith.sh --rehearse --target-origin URL
  scripts/cutover-monolith.sh --rollback --target-origin URL

Required cut environment is documented in apps/server/docs/cutover-monolith.md.
The script never imports media and refuses production execution without
CUTOVER_ACK=FORWARD_ONLY_AFTER_REOPEN.
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
if [[ -z "$TARGET_ORIGIN" && ( "$MODE" == execute || "$MODE" == rollback ) ]]; then
  TARGET_ORIGIN="$PRODUCTION_MONOLITH_ORIGIN"
fi
[[ -n "$TARGET_ORIGIN" ]] || { usage >&2; exit 2; }
[[ "$TARGET_ORIGIN" =~ ^https?://[^/]+$ ]] || {
  echo 'target origin must be an HTTP(S) origin without a path' >&2
  exit 2
}
if [[ "$MODE" == execute && "${CUTOVER_ACK:-}" != 'FORWARD_ONLY_AFTER_REOPEN' ]]; then
  echo 'refusing production cut: set CUTOVER_ACK=FORWARD_ONLY_AFTER_REOPEN' >&2
  exit 2
fi
if [[ "$MODE" == execute && "$TARGET_ORIGIN" != "$PRODUCTION_MONOLITH_ORIGIN" ]]; then
  echo "production execute target must be $PRODUCTION_MONOLITH_ORIGIN; use --rehearse for scratch" >&2
  exit 2
fi
if [[ "$MODE" == execute && -n "${CUTOVER_IMPORT_COMMAND:-}" ]]; then
  echo 'CUTOVER_IMPORT_COMMAND is rehearsal-only; unset it before production execute' >&2
  exit 2
fi

TARGET_DATABASE_URL="${DATABASE_URL:-}"
if [[ "$MODE" != rollback && -z "$TARGET_DATABASE_URL" ]]; then
  echo 'DATABASE_URL is required' >&2
  exit 2
fi
STATE_ROOT="${CUTOVER_STATE_ROOT:-.cutover-state}"
mkdir -p "$STATE_ROOT"
TARGET_KEY="$(printf '%s' "$TARGET_ORIGIN" | sha256sum | cut -c1-16)"
STATE_FILE="$STATE_ROOT/monolith-${TARGET_KEY}.state"
touch "$STATE_FILE"

log() { printf '[cutover] %s\n' "$*"; }
die() { printf '[cutover] FAILED: %s\n' "$*" >&2; exit 1; }
done_step() { grep -Fxq "$1" "$STATE_FILE"; }
mark_step() { done_step "$1" || printf '%s\n' "$1" >> "$STATE_FILE"; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

run_hook() {
  local variable="$1" label="$2"
  local command_text="${!variable:-}"
  [[ -n "$command_text" ]] || die "$variable is required for $label"
  log "$label"
  bash -euo pipefail -c "$command_text"
}

preflight() {
  log 'preflight: server health, Neon reachability, migrated schema'
  curl --fail --silent --show-error "$TARGET_ORIGIN/healthz" |
    jq -e '.ok == true' >/dev/null || die 'target /healthz did not return {ok:true}'
  psql "$TARGET_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc 'SELECT 1' |
    grep -Fxq 1 || die 'target database is unreachable'
  psql "$TARGET_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc \
    "SELECT count(*) FROM unnest(ARRAY['identities','rooms','messages','daemon_tokens','push_delivery_claims']) name WHERE to_regclass('public.'||name) IS NOT NULL" |
    grep -Fxq 5 || die 'target schema is not fully migrated'
  run_hook CUTOVER_PHONE_AUTH_VERIFY_COMMAND \
    'preflight verify: phone GitHub ticket exchange reaches the configured auth boundary'
  mark_step preflight
}

drain() {
  if ! done_step drain-action; then
    run_hook CUTOVER_DRAIN_COMMAND 'drain: stop new turns and request graceful daemon drain'
    mark_step drain-action
  fi
  run_hook CUTOVER_DRAIN_VERIFY_COMMAND 'drain verify: wait until active agent turns reach zero'
  mark_step drain
}

freeze() {
  if ! done_step freeze-action; then
    run_hook CUTOVER_FREEZE_COMMAND 'freeze: put the old write API into maintenance/read-only mode'
    mark_step freeze-action
  fi
  run_hook CUTOVER_FREEZE_VERIFY_COMMAND 'freeze verify: prove old writes are rejected and reads still work'
  mark_step freeze
}

final_snapshot_import() {
  local import_id="${IMPORT_ID:-cutover-${TARGET_KEY}}"
  [[ "$import_id" =~ ^[A-Za-z0-9._:-]+$ ]] || die 'IMPORT_ID contains unsafe characters'
  if done_step import; then
    log 'import: prior import recorded; re-verifying target instead of re-running'
  elif [[ -n "${CUTOVER_IMPORT_COMMAND:-}" ]]; then
    [[ "$MODE" == rehearse ]] ||
      die 'CUTOVER_IMPORT_COMMAND is rehearsal-only; production must use the built-in snapshot importer'
    run_hook CUTOVER_IMPORT_COMMAND 'snapshot/import: run the configured local rehearsal importer'
    mark_step import
  else
    [[ -n "${OLD_DATABASE_URL:-}" && -n "${OLD_PUSH_REGISTRY_JSON:-}" ]] ||
      die 'OLD_DATABASE_URL and OLD_PUSH_REGISTRY_JSON are required for the final import'
    local report="$STATE_ROOT/import-${TARGET_KEY}.json"
    log 'snapshot/import: repeatable-read final snapshot into DATABASE_URL (legacy media excluded)'
    OLD_DATABASE_URL="$OLD_DATABASE_URL" \
      DATABASE_URL="$TARGET_DATABASE_URL" \
      OLD_PUSH_REGISTRY_JSON="$OLD_PUSH_REGISTRY_JSON" \
      IMPORT_ID="$import_id" \
      npm run import -w @beeline/server > "$report"
    jq -e '.report.mediaBytes == 0 and .measurement.fitsNeonFree == true' "$report" >/dev/null ||
      die 'import report failed zero-media or Neon-size verification'
    mark_step import
  fi
  psql "$TARGET_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc \
    "SELECT count(*) FROM import_runs WHERE import_id = '$import_id' AND state='complete'" |
    grep -Fxq 1 || die "target import $import_id is not complete"
}

stage_daemon_runtimes() {
  local manifest="${DAEMON_EXCHANGE_MANIFEST:-}"
  [[ -n "$manifest" && -f "$manifest" ]] || die 'DAEMON_EXCHANGE_MANIFEST must name a protected JSON manifest'
  local manifest_mode
  manifest_mode="$(stat -c '%a' "$manifest")"
  (( (8#$manifest_mode & 077) == 0 )) || die 'DAEMON_EXCHANGE_MANIFEST must not be group/world accessible'
  TARGET_ORIGIN="$TARGET_ORIGIN" node --input-type=module - "$manifest" <<'NODE'
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const manifestPath = process.argv[2];
const entries = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(entries) || entries.length === 0) throw new Error('daemon exchange manifest is empty');
for (const entry of entries) {
  if (!entry || typeof entry.runtimePath !== 'string' || !/^[0-9a-f]{64}$/.test(entry.agentId) ||
      typeof entry.exchangeToken !== 'string' || !/^bde_[A-Za-z0-9_-]{43}$/.test(entry.exchangeToken)) {
    throw new Error('daemon exchange manifest entry is invalid');
  }
  const path = resolve(entry.runtimePath);
  const runtime = JSON.parse(await readFile(path, 'utf8'));
  if (runtime.version !== 2 || runtime.agent?.publicKey !== entry.agentId) {
    throw new Error(`runtime identity mismatch at ${path}`);
  }
  if (runtime.transport?.kind === 'monolith' && runtime.transport.daemonToken) {
    if (runtime.transport.baseUrl !== process.env.TARGET_ORIGIN) {
      throw new Error(`promoted runtime points at a different monolith origin: ${path}`);
    }
    continue;
  }
  runtime.transport = {
    kind: 'monolith',
    baseUrl: process.env.TARGET_ORIGIN,
    exchangeToken: entry.exchangeToken,
  };
  const temporary = `${path}.cutover-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
NODE
}

flip() {
  if ! done_step daemon-runtime-stage; then
    log 'flip: stage monolith transport and one-use credentials in daemon runtimes'
    stage_daemon_runtimes
    mark_step daemon-runtime-stage
  fi
  if ! done_step daemon-restart; then
    run_hook CUTOVER_DAEMON_RESTART_COMMAND 'flip: gracefully restart daemon fleet for token exchange'
    mark_step daemon-restart
  fi
  run_hook CUTOVER_DAEMON_VERIFY_COMMAND 'flip verify: prove every daemon promoted bde_ to durable bdt_'
  if ! done_step ota-flip; then
    run_hook CUTOVER_OTA_FLIP_COMMAND 'flip: promote the cut OTA phone transport'
    mark_step ota-flip
  fi
  run_hook CUTOVER_OTA_VERIFY_COMMAND 'flip verify: require owner-device receipt for the cut build'
  mark_step flip
}

verify_end_to_end() {
  run_hook CUTOVER_E2E_VERIFY_COMMAND \
    'verify: production send -> daemon receipt -> reply -> read -> push claim'
  mark_step verify
}

reopen() {
  if ! done_step reopen-action; then
    run_hook CUTOVER_REOPEN_COMMAND 'reopen: enable monolith writes'
    mark_step reopen-action
  fi
  run_hook CUTOVER_REOPEN_VERIFY_COMMAND 'reopen verify: prove monolith writes are enabled'
  mark_step reopened
  log 'WRITES ARE OPEN. ROLLBACK IS NOW FORWARD-ONLY. NEVER WRITE TO THE OLD SNAPSHOT.'
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

require_command curl
require_command jq
require_command psql
require_command stat
if [[ "$MODE" == rollback ]]; then rollback; exit 0; fi

preflight
drain
freeze
final_snapshot_import
flip
verify_end_to_end
reopen
log "$MODE completed; state recorded at $STATE_FILE"
