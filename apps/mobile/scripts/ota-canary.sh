#!/usr/bin/env bash
# Install the latest beta-channel APK on the existing AVD, let it fetch the
# candidate, then run the real Room open/send/reply Maestro smoke. The outer
# timeout is part of the contract: a wedged emulator can never hold promotion
# for more than ten minutes.
#
# Exit codes: 0 canary passed; 1 smoke/flow failure; 2 environment or setup
# failure (the release governor PARKS promotion on this with an actionable
# reason recorded in the ledger); 124 the ten-minute deadline fired.
#
# Parked-reason contract (round-2 hardening of #490): every preflight or
# runner-environment failure must be SELF-DESCRIBING. park() prints one
# actionable line and, when OTA_CANARY_REASON_FILE is set (the workflow pins it
# to a file under RUNNER_TEMP), writes that same single line there so the
# governor records it verbatim in the release ledger even if nothing else in
# this run is readable. A failure that kills the shell before any handler runs
# is still classified by exit code at the workflow layer.
set -euo pipefail

readonly MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly DEVICE="${MAESTRO_DEVICE:-emulator-5554}"
readonly APP_ID="app.usebeeline.mobile"
readonly MAX_SECONDS="${OTA_CANARY_MAX_SECONDS:-600}"
readonly UPDATE_APPLY_TIMEOUT="${OTA_CANARY_UPDATE_APPLY_TIMEOUT_SECONDS:-120}"
readonly UPDATE_PROBE_TIMEOUT="${OTA_CANARY_UPDATE_PROBE_TIMEOUT_SECONDS:-5}"

park() {
  local reason="${1:-unknown OTA canary environment or setup failure}"
  echo "OTA canary parked promotion: $reason" >&2
  if [[ -n "${OTA_CANARY_REASON_FILE:-}" ]]; then
    printf '%s\n' "$reason" > "$OTA_CANARY_REASON_FILE" 2>/dev/null || true
  fi
  exit 2
}

# The release-host runner account does not carry the emulator owner's PATH.
# Resolve adb without assuming it is on PATH so the governed canary can run
# wherever the sanctioned emulator lives; ANDROID_HOME/ANDROID_SDK_ROOT name
# the SDK explicitly (the workflow pins it for the self-hosted runner).
resolve_adb() {
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return 0
  fi
  local candidate
  for candidate in \
    "${ANDROID_HOME:-}/platform-tools/adb" \
    "${ANDROID_SDK_ROOT:-}/platform-tools/adb"; do
    if [[ -n "${candidate%/platform-tools/adb}" && -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# GitHub Actions starts the self-hosted runner with a non-login PATH, while the
# supported Maestro installer places the executable under ~/.maestro/bin.
# Resolve that installation explicitly and expose it to maestro-e2e.sh, whose
# bare `maestro` invocation must never fail as an opaque exit 127.
resolve_maestro() {
  if [[ -n "${MAESTRO_BIN:-}" ]]; then
    [[ -x "$MAESTRO_BIN" ]] || return 1
    printf '%s' "$MAESTRO_BIN"
    return 0
  fi
  if command -v maestro >/dev/null 2>&1; then
    command -v maestro
    return 0
  fi
  local candidate="${MAESTRO_HOME:-${HOME:-}/.maestro}/bin/maestro"
  if [[ -x "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  return 1
}

if ! ADB_BIN="$(resolve_adb)"; then
  cat >&2 <<EOF
OTA canary cannot find the Android platform-tools binary (adb).
Searched: PATH, \$ANDROID_HOME/platform-tools/adb, \$ANDROID_SDK_ROOT/platform-tools/adb.
Fix: install platform-tools on the release host or set ANDROID_HOME to the
SDK root in the release-governor job, then re-run the canary step.
Production promotion stays parked until the canary passes.
EOF
  park "adb is not resolvable on the release-host runner (searched PATH, ANDROID_HOME/platform-tools/adb, ANDROID_SDK_ROOT/platform-tools/adb)"
fi
if [[ "$ADB_BIN" == */* ]]; then
  # Child scripts (maestro-e2e.sh, android-teardown.sh) still call bare `adb`;
  # make our resolution visible to them instead of editing each one.
  export PATH="$(dirname "$ADB_BIN"):$PATH"
fi

if ! MAESTRO_BIN_RESOLVED="$(resolve_maestro)"; then
  park "Maestro is not executable on the release-host runner (searched MAESTRO_BIN, PATH, and \${MAESTRO_HOME:-\$HOME/.maestro}/bin/maestro). Install Maestro for the runner account or set MAESTRO_BIN to its executable, then re-run the governor"
fi
if [[ "$MAESTRO_BIN_RESOLVED" == */* ]]; then
  export PATH="$(dirname "$MAESTRO_BIN_RESOLVED"):$PATH"
fi

if [[ "${OTA_CANARY_DEADLINE_ACTIVE:-0}" != "1" ]]; then
  if (( MAX_SECONDS < 1 || MAX_SECONDS > 600 )); then
    park "OTA_CANARY_MAX_SECONDS must be between 1 and 600 (got ${MAX_SECONDS})"
  fi
  exec timeout --foreground --signal=TERM "${MAX_SECONDS}s" \
    env OTA_CANARY_DEADLINE_ACTIVE=1 "$0" "$@"
fi

if ! [[ "$UPDATE_APPLY_TIMEOUT" =~ ^[0-9]+$ ]] ||
  (( UPDATE_APPLY_TIMEOUT < 1 || UPDATE_APPLY_TIMEOUT > 300 )); then
  park "OTA_CANARY_UPDATE_APPLY_TIMEOUT_SECONDS must be between 1 and 300 (got ${UPDATE_APPLY_TIMEOUT})"
fi
if ! [[ "$UPDATE_PROBE_TIMEOUT" =~ ^[0-9]+$ ]] ||
  (( UPDATE_PROBE_TIMEOUT < 1 || UPDATE_PROBE_TIMEOUT > 60 )); then
  park "OTA_CANARY_UPDATE_PROBE_TIMEOUT_SECONDS must be between 1 and 60 (got ${UPDATE_PROBE_TIMEOUT})"
fi

device_state="$("$ADB_BIN" devices 2>&1 | awk -v d="$DEVICE" '$1 == d { print $2; exit }')" || {
  echo "Canary adb could not enumerate devices. Output:" >&2
  echo "$device_state" >&2
  echo "Fix: check the shared adb server on the release host (adb kill-server && adb start-server as the emulator owner), then re-run." >&2
  park "adb devices could not enumerate devices on the release host; the shared adb server on port 5037 is unreachable or unhealthy"
}
case "$device_state" in
  device) ;;
  '')
    echo "Canary requires the existing Android emulator $DEVICE, and none is attached to adb right now." >&2
    echo "Fix: boot the sanctioned existing AVD ($DEVICE) on the release host under the emulator-owner account; the canary attaches to it over the shared adb server. It must be live before the release governor runs." >&2
    park "the sanctioned Android emulator $DEVICE is not attached to the shared adb server on the release host; boot it under the emulator-owner account before the governor runs"
    ;;
  *)
    echo "Canary emulator $DEVICE is attached but not ready (state: $device_state)." >&2
    echo "Fix: wait for boot or re-authorize the device on the release host, then re-run." >&2
    park "canary emulator $DEVICE is attached but not ready (state: $device_state); wait for boot or re-authorize the device on the release host"
    ;;
esac

ledger=""
while (($#)); do
  case "$1" in
    --ledger)
      ledger="${2:-}"
      shift 2
      ;;
    *)
      echo "usage: ota-canary.sh --ledger <mobile-ota-ledger.json>" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$ledger" ]]; then
  park "canary ledger not found: $ledger; the beta-candidate publish step must succeed before the canary runs"
fi

set +e
candidate_group="$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.candidateGroupId || "")' "$ledger")"
android_update="$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.androidUpdateId || "")' "$ledger")"
android_runtime="$(node -e 'const x=require(process.argv[1]); const update=x.candidateUpdates?.find((item) => item.platform === "android"); process.stdout.write(update?.runtimeVersion || "")' "$ledger")"
ledger_status=$?
set -e
if (( ledger_status != 0 )); then
  park "canary ledger at $ledger is unreadable or malformed JSON (node exited ${ledger_status}); the release-governor candidate step must produce a readable mobile-ota-ledger.json"
fi
if [[ -z "$candidate_group" || -z "$android_update" ]]; then
  park "canary ledger is missing candidateGroupId or androidUpdateId: $ledger"
fi

temporary="$(mktemp -d)"
cleanup() {
  local status=$?
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT INT TERM

apk="${BEELINE_BETA_APK:-}"
if [[ -z "$apk" ]]; then
  build_json="$temporary/beta-build.json"
  build_args=(
    build:list
    --platform android
    --build-profile beta-apk
    --status finished
    --limit 1
    --json
    --non-interactive
  )
  if [[ -n "$android_runtime" ]]; then
    build_args+=(--runtime-version "$android_runtime")
  fi
  set +e
  npx --yes eas-cli@22.2.0 "${build_args[@]}" > "$build_json"
  build_status=$?
  set -e
  if (( build_status != 0 )); then
    park "could not list EAS builds (npx eas-cli@22.2.0 exited ${build_status}); check EXPO_TOKEN and network access on the release host, then re-run the governor"
  fi
  set +e
  build_url="$(node -e '
    const builds = require(process.argv[1]);
    const build = Array.isArray(builds) ? builds[0] : builds?.data?.[0];
    const url = build?.artifacts?.buildUrl ?? build?.artifacts?.applicationArchiveUrl;
    if (typeof url !== "string" || !url) process.exit(1);
    process.stdout.write(url);
  ' "$build_json")"
  url_status=$?
  set -e
  if (( url_status != 0 )) || [[ -z "$build_url" ]]; then
    park "EAS has no finished beta-apk Android build for runtime version ${android_runtime:-unknown}. A beta-channel binary is the only possible canary vehicle because the OTA update channel is baked into the APK at build time; production-channel binaries cannot fetch the beta candidate group. Fix once per runtime version: cd apps/mobile && npx --yes eas-cli@22.2.0 build --profile beta-apk --platform android --non-interactive, then re-run the release governor."
  fi
  apk="$temporary/beeline-beta.apk"
  if ! curl --fail --location --silent --show-error "$build_url" --output "$apk"; then
    park "could not download the beta APK from EAS (curl failed fetching the recorded buildUrl); check network access on the release host and that the build artifact still exists, then re-run the governor"
  fi
fi

if [[ ! -f "$apk" ]]; then
  park "operator-supplied BEELINE_BETA_APK does not exist: $apk; point it at a beta-channel (EXPO_UPDATES_CHANNEL=beta) APK built for runtime version ${android_runtime:-unknown}, or unset it to let the canary download the latest EAS beta-apk build"
fi

# -r preserves the dedicated beta binary registration while replacing any
# older beta build. pm clear then gives the smoke its normal cold-device state.
# A differently-signed existing installation (e.g. an operator's locally-built
# apk:release artifact vs the EAS-keyed beta binary) makes adb refuse the
# update with INSTALL_FAILED_UPDATE_INCOMPATIBLE; the canary owns exactly this
# one package on the sanctioned device, so it removes that package and retries
# once before parking.
set +e
install_output="$(adb -s "$DEVICE" install -r "$apk" 2>&1)"
install_status=$?
set -e
case "$install_output" in
  *INSTALL_FAILED_UPDATE_INCOMPATIBLE*)
    echo "Existing $APP_ID on $DEVICE has a different signature; removing exactly the canary package and retrying the install once." >&2
    if ! adb -s "$DEVICE" uninstall "$APP_ID" >/dev/null 2>&1; then
      park "could not remove the differently-signed existing $APP_ID from $DEVICE after INSTALL_FAILED_UPDATE_INCOMPATIBLE; uninstall the canary package manually on the release host, then re-run the governor"
    fi
    set +e
    install_output="$(adb -s "$DEVICE" install -r "$apk" 2>&1)"
    install_status=$?
    set -e
    if (( install_status != 0 )); then
      park "adb install of the beta APK failed on $DEVICE even after removing the differently-signed existing package: ${install_output}"
    fi
    ;;
  *)
    if (( install_status != 0 )); then
      park "adb install of the beta APK failed on $DEVICE: ${install_output}"
    fi
    ;;
esac
adb -s "$DEVICE" shell pm clear "$APP_ID" >/dev/null || {
  park "adb pm clear failed on $DEVICE for $APP_ID; the emulator is reachable but the app data could not be reset"
}
adb -s "$DEVICE" shell monkey -p "$APP_ID" 1 >/dev/null || {
  park "adb could not launch $APP_ID on $DEVICE; the installed beta binary failed to start"
}

# Poll the identity reported by the running JS bundle. Expo may download an
# update on one cold start and select it only on the next; a fixed sleep cannot
# distinguish a slow-but-healthy fetch from a stale bundle. Product flows stay
# structurally unreachable until the expected candidate reports itself.
update_deadline=$((SECONDS + UPDATE_APPLY_TIMEOUT))
update_probe_log="$temporary/update-identity-probe.log"
update_applied=0
while (( SECONDS <= update_deadline )); do
  if MAESTRO_REUSE_INSTALLED_APP=1 \
    MAESTRO_SKIP_BUILD=1 \
    MAESTRO_KEEP_DEVICE=1 \
    MAESTRO_VERIFY_UPDATE_ONLY=1 \
    MAESTRO_UPDATE_IDENTITY_TIMEOUT_SECONDS="$UPDATE_PROBE_TIMEOUT" \
    EXPECTED_ANDROID_UPDATE_ID="$android_update" \
      "$MOBILE_DIR/scripts/maestro-e2e.sh" >"$update_probe_log" 2>&1; then
    cat "$update_probe_log"
    update_applied=1
    break
  fi
  if (( SECONDS > update_deadline )); then
    break
  fi
  "$ADB_BIN" -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null || {
    park "adb am force-stop failed on $DEVICE for $APP_ID while polling for Android update $android_update; the emulator stopped responding"
  }
  "$ADB_BIN" -s "$DEVICE" shell monkey -p "$APP_ID" 1 >/dev/null || {
    park "adb could not relaunch $APP_ID on $DEVICE while polling for Android update $android_update; the installed beta binary failed to restart"
  }
done
if (( update_applied != 1 )); then
  probe_reason="$(tail -n 1 "$update_probe_log" 2>/dev/null || true)"
  park "expected beta Android update $android_update was not reported running on $DEVICE within ${UPDATE_APPLY_TIMEOUT}s; update fetch/reload did not converge${probe_reason:+ (last probe: $probe_reason)}"
fi

smoke_log="$temporary/maestro-smoke.log"
set +e
MAESTRO_REUSE_INSTALLED_APP=1 \
MAESTRO_SKIP_BUILD=1 \
MAESTRO_KEEP_DEVICE=1 \
MAESTRO_FLOW="$MOBILE_DIR/e2e/ota-canary.yaml" \
EXPECTED_ANDROID_UPDATE_ID="$android_update" \
EXPECTED_UPDATE_GROUP_ID="$candidate_group" \
  "$MOBILE_DIR/scripts/maestro-e2e.sh" 2>&1 | tee "$smoke_log"
smoke_status=$?
set -e
if (( smoke_status != 0 )); then
  # A provisioning-bootstrap death (e.g. the runner checkout missing the
  # workspace prerequisites scripts/provision-smoke.ts imports) is an
  # environment failure and must park self-describingly, not exit as a
  # generic smoke failure. Anything else keeps the genuine smoke-failure
  # exit code.
  bootstrap_line="$(grep -m1 -E 'Cannot find module|MODULE_NOT_FOUND' "$smoke_log" 2>/dev/null || true)"
  if [[ -n "$bootstrap_line" ]]; then
    park "the canary smoke could not start: its provisioning bootstrap failed before Maestro ran (${bootstrap_line})"
  fi
  exit "$smoke_status"
fi

echo "OTA canary passed for beta group $candidate_group (Android update $android_update)."
