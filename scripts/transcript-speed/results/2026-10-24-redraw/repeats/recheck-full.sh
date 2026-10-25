#!/usr/bin/env bash
set -euo pipefail
export PATH=/home/lunchbox/.nvm/versions/node/v20.11.0/bin:/home/lunchbox/android-sdk/platform-tools:/usr/local/bin:/usr/bin:/bin
export ANDROID_ADB_SERVER_PORT=5950
export LATENCY_RIG_DEVICE=127.0.0.1:5555
export LATENCY_RIG_DATABASE_URL='postgresql://localhost/beeline_latency_rig_transcript_jellybean?host=%2Fvar%2Frun%2Fpostgresql'
export TRANSCRIPT_CONTROL_PORT=19906
export TRANSCRIPT_SKIP_HISTORY=1
export TRANSCRIPT_REPEAT_COUNT=3
for recheck_arm in before after; do
  recheck_output="scripts/latency-rig/.local/recheck-full-${recheck_arm}"
  mkdir -p "$recheck_output"
  if [ "$recheck_arm" = before ]; then
    export TRANSCRIPT_APK=scripts/latency-rig/.local/before.apk
  else
    export TRANSCRIPT_APK=scripts/latency-rig/.local/redraw-measured.apk
  fi
  if adb -s "$LATENCY_RIG_DEVICE" shell pm path app.usebeeline | rg -q package; then
    adb -s "$LATENCY_RIG_DEVICE" uninstall app.usebeeline
  fi
  adb -s "$LATENCY_RIG_DEVICE" install "$TRANSCRIPT_APK"
  node scripts/transcript-speed/reset.mjs
  adb -s "$LATENCY_RIG_DEVICE" root
  adb -s "$LATENCY_RIG_DEVICE" wait-for-device
  adb -s "$LATENCY_RIG_DEVICE" reverse tcp:19886 tcp:19906
  adb -s "$LATENCY_RIG_DEVICE" reverse tcp:19882 tcp:19882
  adb -s "$LATENCY_RIG_DEVICE" shell iptables -t nat -C OUTPUT -p tcp -d 10.0.2.2 --dport 19886 -j DNAT --to-destination 127.0.0.1:19886 || adb -s "$LATENCY_RIG_DEVICE" shell iptables -t nat -A OUTPUT -p tcp -d 10.0.2.2 --dport 19886 -j DNAT --to-destination 127.0.0.1:19886
  adb -s "$LATENCY_RIG_DEVICE" shell pm grant app.usebeeline android.permission.POST_NOTIFICATIONS
  adb -s "$LATENCY_RIG_DEVICE" shell am start -a android.intent.action.VIEW -d beeline://review/transcript-fixture-local-only-36bbb7b4 app.usebeeline/.MainActivity
  sleep 3
  node -e 'const fs=require("fs"),os=require("os");fs.writeFileSync(process.argv[1],JSON.stringify({at:new Date().toISOString(),load:os.loadavg(),freeMemory:os.freemem()},null,2))' "$recheck_output/host.json"
  node scripts/transcript-speed/capture-android.mjs "$recheck_output" > "$recheck_output/run.log" 2>&1
  echo "Completed $recheck_arm"
done
