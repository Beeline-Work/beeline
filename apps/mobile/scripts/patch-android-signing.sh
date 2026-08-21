#!/usr/bin/env bash
# Patch android/app/build.gradle to use the release signing config.
# Called by npm run apk:release after expo prebuild generates the android directory.

set -euo pipefail

BUILD_GRADLE="android/app/build.gradle"

if [ ! -f "$BUILD_GRADLE" ]; then
  echo "Error: $BUILD_GRADLE not found. Run 'npx expo prebuild --platform android' first."
  exit 1
fi

# Add release signing config block after debug signingConfigs
if grep -q 'buzz-release' "$BUILD_GRADLE"; then
  echo "Signing config already patched."
  exit 0
fi

# Use python for precise editing
python3 << EOF
import os
content = open('$BUILD_GRADLE', 'r').read()

# Add release signing config after debug signingConfigs
old_debug_block = '''    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }'''

new_signing_block = '''    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            storeFile file('../../android-signing/release.keystore')
            storePassword 'buzzyrel123'
            keyAlias 'buzz-release'
            keyPassword 'buzzyrel123'
        }
    }'''

content = content.replace(old_debug_block, new_signing_block)

# Point release build type at the release signing config
content = content.replace(
    '''        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug''',
    '''        release {
            signingConfig signingConfigs.release'''
)

open('$BUILD_GRADLE', 'w').write(content)
print('Patched signing config.')

# Sideload builds must support operator-provided HTTP relays on a LAN.
manifest = 'android/app/src/main/AndroidManifest.xml'
if os.path.exists(manifest):
    manifest_content = open(manifest, 'r').read()
    if 'android:usesCleartextTraffic=' not in manifest_content:
        manifest_content = manifest_content.replace(
            '<application ',
            '<application android:usesCleartextTraffic="true" ',
            1,
        )
        open(manifest, 'w').write(manifest_content)
        print('Enabled cleartext traffic for operator-provided LAN relays.')
EOF
