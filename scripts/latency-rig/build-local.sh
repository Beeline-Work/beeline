#!/usr/bin/env bash
# Locally signed Hermes release APK; never uses the production sideload key.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
mobile_dir="$repo_dir/apps/mobile"
local_dir="$repo_dir/scripts/latency-rig/.local"
mkdir -p "$local_dir"
keystore="$local_dir/release-rig.p12"
server_url="${EXPO_PUBLIC_BUZZY_MONOLITH_URL:-http://10.0.2.2:8081}"
if [[ "$server_url" != http://10.0.2.2:* && "$server_url" != https://10.0.2.2:* ]]; then
  echo 'Rig APK must point only at the disposable emulator host proxy (10.0.2.2)' >&2
  exit 2
fi
export EXPO_PUBLIC_BUZZY_MONOLITH_URL="$server_url"
export EXPO_PUBLIC_ROOM_OPEN_TRACE=1
export EXPO_UPDATES_CHANNEL=latency-rig
export BEELINE_ANDROID_KEEP_DEVICE=1
# The dedicated AVD is x86_64; skip three unused native ABI builds.
export ORG_GRADLE_PROJECT_reactNativeArchitectures=x86_64
export ANDROID_SIDELOAD_KEY_ALIAS=latency-rig
export ANDROID_SIDELOAD_STORE_PASSWORD="${LATENCY_RIG_KEY_PASSWORD:-latency-rig-only-password}"
export ANDROID_SIDELOAD_KEY_PASSWORD="$ANDROID_SIDELOAD_STORE_PASSWORD"
if [[ ! -f "$keystore" ]]; then
  keytool -genkeypair -noprompt -storetype PKCS12 -keystore "$keystore" \
    -alias "$ANDROID_SIDELOAD_KEY_ALIAS" -storepass "$ANDROID_SIDELOAD_STORE_PASSWORD" \
    -keypass "$ANDROID_SIDELOAD_KEY_PASSWORD" -keyalg RSA -keysize 2048 \
    -validity 365 -dname 'CN=Beeline Local Latency Rig' >/dev/null
fi
export ANDROID_SIDELOAD_KEYSTORE_B64
ANDROID_SIDELOAD_KEYSTORE_B64="$(base64 -w0 "$keystore")"
cd "$mobile_dir"
bash scripts/android-build.sh
echo "Release rig APK: $mobile_dir/android/app/build/outputs/apk/release/app-release.apk"
