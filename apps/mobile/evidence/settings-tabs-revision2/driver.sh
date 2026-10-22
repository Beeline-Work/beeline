#!/usr/bin/env bash
# Driver for the settings-tabs revision 2 captures. Usage: driver.sh launch | signin | role <owner|member> | link <path>
set -euo pipefail
S=${SERIAL:-emulator-5554}; D="$(dirname "$0")"
adbs(){ adb -s "$S" "$@"; }
wait_for(){ timeout "${2:-90}" bash -c "until python3 '$D/device.py' inspect | grep -q \"$1\"; do sleep 2; done"; }
case "$1" in
  launch) # cold start the dev client against Metro on 18082 (adb reverse tcp:18082, tcp:45861)
    adbs shell am force-stop app.usebeeline
    adbs shell am start -a android.intent.action.VIEW -d "beeline://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A18082" app.usebeeline >/dev/null
    wait_for "ROOMS\|Continue with GitHub\|Continue\|Retry" 240
    if python3 "$D/device.py" inspect | grep -q "'Continue'"; then python3 "$D/device.py" tap Continue; sleep 1; python3 "$D/device.py" tap Close || true; fi ;;
  signin) adbs shell am start -a android.intent.action.VIEW -d "beeline://review/isolated-design-proof-secret-5678" app.usebeeline >/dev/null; wait_for "ROOMS" 90 ;;
  role) curl -s "http://127.0.0.1:45861/_proof/role/$2"; echo ;;
  link) adbs shell am start -a android.intent.action.VIEW -d "beeline://$2" app.usebeeline >/dev/null; sleep 4 ;;
esac
