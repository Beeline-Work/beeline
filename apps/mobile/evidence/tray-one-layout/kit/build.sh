#!/usr/bin/env bash
# build.sh <before|after>: web export then x86_64 release APK from the corner worktree's current files.
set -euo pipefail
REPO=/home/alan/.local/state/beeline/corners/cf8ffb2b-4d7e-40dd-9844-6452ba9889b0
OUT=/home/alan/.cache/niglet-tray-shots
export ANDROID_HOME=/home/alan/android-sdk ANDROID_SDK_ROOT=/home/alan/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:8897
export EXPO_UPDATES_CHANNEL=niglet-tray-local-none
export GRADLE_USER_HOME=/home/alan/.gradle-fanout EXPO_NO_TELEMETRY=1 CI=1
export NODE_OPTIONS=--max-old-space-size=6144
export CCACHE_DIR=/home/alan/.cache/beeline-android-ccache CCACHE_BASEDIR="$REPO" CCACHE_NOHASHDIR=true
cd "$REPO/apps/mobile"
rm -rf "$OUT/web-$1"
npx expo export --platform web --output-dir "$OUT/web-$1" > "$OUT/work/web-$1.log" 2>&1
echo "web $1 done"
if [[ ! -d android ]]; then
  npx expo prebuild --platform android --clean --no-install > "$OUT/work/prebuild.log" 2>&1
  sed -i 's#<application #<application android:usesCleartextTraffic="true" #' android/app/src/main/AndroidManifest.xml
fi
cd android
./gradlew --no-daemon --max-workers=6 -Dorg.gradle.jvmargs=-Xmx6g --init-script /home/alan/.cache/beeline-2880-shots/work/limit-init.gradle assembleRelease -PreactNativeArchitectures=x86_64 > "$OUT/work/apk-$1.log" 2>&1
cp app/build/outputs/apk/release/app-release.apk "$OUT/$1.apk"
echo "apk $1 done"
