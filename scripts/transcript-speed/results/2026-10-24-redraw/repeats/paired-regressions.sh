#!/usr/bin/env bash
set -euo pipefail
export LATENCY_RIG_DEVICE=emulator-5566
export LATENCY_RIG_DATABASE_URL='postgresql://localhost/beeline_latency_rig_transcript_jellybean?host=%2Fvar%2Frun%2Fpostgresql'
export TRANSCRIPT_CONTROL_PORT=19896
export TRANSCRIPT_SKIP_HISTORY=1
export TRANSCRIPT_REPEAT_COUNT=1
export TRANSCRIPT_REGRESSION_ONLY=1
pair_index=0
for pair_arm in before after after before before after; do
  pair_index=$((pair_index + 1))
  pair_output="scripts/latency-rig/.local/paired-${pair_index}-${pair_arm}"
  mkdir -p "$pair_output"
  if [ "$pair_arm" = before ]; then
    export TRANSCRIPT_APK=scripts/latency-rig/.local/before.apk
  else
    export TRANSCRIPT_APK=scripts/latency-rig/.local/redraw-measured.apk
  fi
  adb -s "$LATENCY_RIG_DEVICE" uninstall app.usebeeline
  adb -s "$LATENCY_RIG_DEVICE" install "$TRANSCRIPT_APK"
  node scripts/transcript-speed/reset.mjs
  adb -s "$LATENCY_RIG_DEVICE" reverse tcp:19886 tcp:19896
  adb -s "$LATENCY_RIG_DEVICE" reverse tcp:19882 tcp:19882
  adb -s "$LATENCY_RIG_DEVICE" shell pm grant app.usebeeline android.permission.POST_NOTIFICATIONS
  adb -s "$LATENCY_RIG_DEVICE" shell am start -a android.intent.action.VIEW -d beeline://review/transcript-fixture-local-only-36bbb7b4 app.usebeeline/.MainActivity
  sleep 3
  node -e 'const fs=require("fs"),os=require("os");fs.writeFileSync(process.argv[1],JSON.stringify({at:new Date().toISOString(),load:os.loadavg(),freeMemory:os.freemem()},null,2))' "$pair_output/host.json"
  node scripts/transcript-speed/capture-android.mjs "$pair_output" > "$pair_output/run.log" 2>&1
  echo "Completed $pair_index $pair_arm"
done
