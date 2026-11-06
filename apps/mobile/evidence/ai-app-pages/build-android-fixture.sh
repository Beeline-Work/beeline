#!/bin/bash
# usage: build1.sh <variant> <theme> ; run from apps/mobile/ai-app-proof
set -e
v=$1; t=$2; o=/tmp/ruby-apk-3959/b/$v-$t; rm -rf $o; mkdir -p $o; pb=0; [ $v = before ] && pb=1
PROOF_BEFORE=$pb EXPO_PUBLIC_PROOF_BEFORE=$pb EXPO_PUBLIC_PROOF_THEME=$t NODE_ENV=production npx expo export:embed --platform android --dev false --entry-file index.js --bundle-output $o/index.js --assets-dest $o/res --reset-cache > $o.log 2>&1
sed -i 's#httpServerLocation:"/assets/_#httpServerLocation:"/assets/#g' $o/index.js
../node_modules/hermes-compiler/hermesc/linux64-bin/hermesc -emit-binary -O -w -out $o/index.android.bundle $o/index.js
cd /tmp/ruby-apk-3959; BT=/home/lunchbox/android-sdk/build-tools/36.0.0; rm -rf stage; mkdir -p stage/assets; cp $o/index.android.bundle stage/assets/
cp pulled/base.apk u-$v-$t.apk; (cd stage && zip -q -0 ../u-$v-$t.apk assets/index.android.bundle)
$BT/zipalign -f -p 4 u-$v-$t.apk a-$v-$t.apk; $BT/apksigner sign --ks key.jks --ks-pass pass:proofpass --out s-$v-$t.apk a-$v-$t.apk
A="/home/lunchbox/android-sdk/platform-tools/adb -H 127.0.0.1 -P 5037 -s emulator-5646"
$A install -r s-$v-$t.apk >/dev/null; $A shell pm clear app.usebeeline >/dev/null; $A logcat -c; $A shell am start -n app.usebeeline/.MainActivity >/dev/null
echo installed $v-$t
