#!/usr/bin/env bash
# capture-android3.sh <before|after>: fresh app data, one seeded scene, Tray (three scroll positions) and #general in Bone and Obsidian.
# Software emulation is slow, so every step waits generously.
set -uo pipefail
side="$1"; dir=/home/alan/.cache/niglet-tray-shots; A="adb -s emulator-5554"
shot() {
  for _ in 1 2 3; do
    $A shell dumpsys window windows 2>/dev/null | grep -q "Application Not Responding" || break
    $A shell input tap 320 1392; sleep 15
  done
  $A exec-out screencap -p > "$1"; echo "$(date +%T) $1"
}
$A reverse tcp:8897 tcp:8897
$A install -r "$dir/$side.apk" >/dev/null
$A shell pm clear app.usebeeline
$A shell pm grant app.usebeeline android.permission.POST_NOTIFICATIONS
general=$(node "$dir/work/seed.mjs" all | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).general))')
$A shell am start -a android.intent.action.VIEW -d "beeline://review/niglet-tray-local-review-secret-01" app.usebeeline
sleep 300
shot "$dir/shots/android-$side-login.png"
for theme in bone obsidian; do
  $A shell cmd uimode night "$([[ $theme == obsidian ]] && echo yes || echo no)"
  $A shell am start -a android.intent.action.VIEW -d "'beeline://beeline/tray?communityId=bee11e00-0000-4000-8000-000000000105'" app.usebeeline
  sleep 150
  shot "$dir/shots/android-$side-tray-$theme-1.png"
  $A shell input swipe 540 2000 540 900 800; sleep 60
  shot "$dir/shots/android-$side-tray-$theme-2.png"
  $A shell input swipe 540 2000 540 900 800; sleep 60
  shot "$dir/shots/android-$side-tray-$theme-3.png"
  $A shell am start -a android.intent.action.VIEW -d "'beeline://beeline/chat/$general'" app.usebeeline
  sleep 150
  shot "$dir/shots/android-$side-chat-$theme.png"
done
$A shell cmd uimode night no
