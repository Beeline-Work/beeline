#!/usr/bin/env bash
# Wait for an already-running Android device to return to a usable adb state.
# This deliberately never starts, stops, or restarts the shared adb server or
# emulator: release and Maestro jobs may be using the same host concurrently.

: "${ADB_BIN:=adb}"
: "${DEVICE:=emulator-5554}"

ANDROID_DEVICE_READY_LAST_STATE="unknown"
ANDROID_DEVICE_READY_VALIDATION_ERROR=""

android_device_ready_log() {
  printf '%s Android device readiness: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

android_device_ready_is_recoverable_state() {
  case "$1" in
    offline|unauthorized|empty) return 0 ;;
    *) return 1 ;;
  esac
}

android_device_ready_listing_state() {
  local devices_output=""
  if ! devices_output="$("$ADB_BIN" devices 2>&1)"; then
    ANDROID_DEVICE_READY_LAST_STATE="adb-unavailable"
    android_device_ready_log "adb devices failed while checking $DEVICE: $devices_output"
    return 4
  fi

  ANDROID_DEVICE_READY_LAST_STATE="$(awk -v device="$DEVICE" '
    $1 == device {
      found = 1
      if (NF > 1) print $2
      else print "empty"
      exit
    }
    END {
      if (!found) print "missing"
    }
  ' <<<"$devices_output")"
}

wait_for_android_device_ready() {
  local timeout="${OTA_CANARY_DEVICE_READY_TIMEOUT_SECONDS:-90}"
  local deadline=""
  local listing_state=""
  local get_state=""
  local boot_completed=""
  local recovery_attempted=0
  local listing_status=0

  if ! [[ "$timeout" =~ ^[0-9]+$ ]] || (( timeout < 1 || timeout > 300 )); then
    ANDROID_DEVICE_READY_VALIDATION_ERROR="OTA_CANARY_DEVICE_READY_TIMEOUT_SECONDS must be between 1 and 300 (got ${timeout})"
    android_device_ready_log "$ANDROID_DEVICE_READY_VALIDATION_ERROR"
    return 2
  fi

  if android_device_ready_listing_state; then
    listing_state="$ANDROID_DEVICE_READY_LAST_STATE"
  else
    listing_status=$?
    if (( listing_status == 4 )); then
      return 4
    fi
    listing_state="$ANDROID_DEVICE_READY_LAST_STATE"
  fi

  if [[ "$listing_state" == "missing" ]]; then
    android_device_ready_log "$DEVICE is not attached to adb."
    return 3
  fi

  deadline=$((SECONDS + timeout))
  while :; do
    if android_device_ready_listing_state; then
      listing_state="$ANDROID_DEVICE_READY_LAST_STATE"
    else
      listing_state="$ANDROID_DEVICE_READY_LAST_STATE"
    fi

    get_state="unavailable"
    if get_state="$("$ADB_BIN" -s "$DEVICE" get-state 2>&1)"; then
      get_state="$(printf '%s' "$get_state" | tr -d '\r\n')"
      [[ -n "$get_state" ]] || get_state="empty"
    fi

    if (( recovery_attempted == 0 )) &&
      { android_device_ready_is_recoverable_state "$listing_state" ||
        android_device_ready_is_recoverable_state "$get_state"; }; then
      recovery_attempted=1
      android_device_ready_log "$DEVICE is attached but reported listing=$listing_state get-state=$get_state; running adb reconnect offline (without restarting the shared adb server)."
      if "$ADB_BIN" reconnect offline >&2; then
        android_device_ready_log "adb reconnect offline completed for $DEVICE; polling for device readiness."
      else
        android_device_ready_log "adb reconnect offline returned non-zero for $DEVICE; continuing bounded readiness polling."
      fi
      continue
    fi

    boot_completed="not-checked"
    if [[ "$listing_state" == "device" && "$get_state" == "device" ]]; then
      boot_completed="$("$ADB_BIN" -s "$DEVICE" shell getprop sys.boot_completed 2>/dev/null || true)"
      boot_completed="$(printf '%s' "$boot_completed" | tr -d '\r\n')"
      [[ -n "$boot_completed" ]] || boot_completed="empty"
      if [[ "$boot_completed" == "1" ]]; then
        ANDROID_DEVICE_READY_LAST_STATE="device"
        android_device_ready_log "$DEVICE is ready (adb device; sys.boot_completed=1)."
        return 0
      fi
    fi

    ANDROID_DEVICE_READY_LAST_STATE="$listing_state"
    android_device_ready_log "$DEVICE readiness probe: listing=$listing_state get-state=$get_state sys.boot_completed=$boot_completed."
    if (( SECONDS >= deadline )); then
      break
    fi
    sleep 1
  done

  android_device_ready_log "$DEVICE did not become ready within ${timeout}s (last state: $ANDROID_DEVICE_READY_LAST_STATE)."
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if wait_for_android_device_ready; then
    exit 0
  fi
  readiness_status=$?
  android_device_ready_log "$DEVICE readiness check failed (last state: $ANDROID_DEVICE_READY_LAST_STATE)."
  exit "$readiness_status"
fi
