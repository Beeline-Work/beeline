#!/usr/bin/env bash
# Release APK for the dead-connection proof: points only at the emulator host
# (https://10.0.2.2:8444) and trusts one throwaway proof CA. Never a store build.
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
mobile_dir="$(cd "$proof_dir/.." && pwd -P)"
ca="$proof_dir/.local/ca.pem"
[[ -f "$ca" ]] || { echo "Run setup.sh first: $ca is missing" >&2; exit 2; }

export EXPO_PUBLIC_BUZZY_MONOLITH_URL="${PROOF_SERVER_URL:-https://10.0.2.2:8444}"
export EXPO_UPDATES_CHANNEL=dead-connection-proof
export ORG_GRADLE_PROJECT_reactNativeArchitectures=x86_64
export GRADLE_USER_HOME="${PROOF_GRADLE_USER_HOME:-${GRADLE_USER_HOME:-$HOME/.gradle}}"

cd "$mobile_dir"
npx expo prebuild --platform android --clean --no-install
python3 - "$ca" <<'EOF'
import pathlib, re, shutil, sys
res = pathlib.Path('android/app/src/main/res')
(res / 'raw').mkdir(exist_ok=True)
(res / 'xml').mkdir(exist_ok=True)
shutil.copy(sys.argv[1], res / 'raw' / 'dead_connection_proof_ca.pem')
(res / 'xml' / 'dead_connection_proof_network.xml').write_text('''<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config>
    <trust-anchors>
      <certificates src="system" />
      <certificates src="@raw/dead_connection_proof_ca" />
    </trust-anchors>
  </base-config>
</network-security-config>
''')
manifest = pathlib.Path('android/app/src/main/AndroidManifest.xml')
text = manifest.read_text()
text = re.sub(r'\s+android:networkSecurityConfig="[^"]*"', '', text)
text = text.replace('<application ', '<application android:networkSecurityConfig="@xml/dead_connection_proof_network" ', 1)
manifest.write_text(text)
EOF
(cd android && ./gradlew assembleRelease)
echo "APK: $mobile_dir/android/app/build/outputs/apk/release/app-release.apk"
