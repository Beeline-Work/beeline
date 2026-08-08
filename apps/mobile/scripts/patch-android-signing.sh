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

# Remove google-services plugin (no Firebase project for Buzzy sideload builds)
# The line is at the end of the file; strip it by removing the whole line
content = '\n'.join(l for l in content.split('\n') if 'com.google.gms.google-services' not in l)

# Also check if the google-services.json needs replacing — remove the plugin line
# from settings.gradle if present
open('$BUILD_GRADLE', 'w').write(content)
print('Patched signing config + removed google-services plugin.')

# Patch settings.gradle if it references google-services
settings_gradle = 'android/settings.gradle'
if os.path.exists(settings_gradle):
    sg = open(settings_gradle, 'r').read()
    if 'google-services' in sg:
        sg = sg.replace("id 'com.google.gms.google-services' version '", "// id 'com.google.gms.google-services' version '")
        sg = sg.replace("id 'com.google.gms.google-services'", "// id 'com.google.gms.google-services'")
        open(settings_gradle, 'w').write(sg)
        print('Also patched settings.gradle.')

# Replace google-services.json with a stub matching the buzzy package names
gs_json = 'android/app/google-services.json'
stub = '''{
  "project_info": {
    "project_number": "0",
    "project_id": "buzzy-sideload"
  },
  "client": [
    {
      "client_info": {
        "mobilesdk_app_id": "1:0:android:0000000000000000",
        "android_client_info": {
            "package_name": "app.buzzy.mobile"
        }
      },
      "oauth_client": [],
      "api_key": [{"current_key": "stub"}],
      "services": {"appinvite_service": {"other_platform_oauth_client": []}}
    }
  ],
  "configuration_version": "1"
}'''
if os.path.exists(gs_json):
    open(gs_json, 'w').write(stub)
    print('Replaced google-services.json stubs for all package names.')
else:
    # Ensure directory exists
    os.makedirs(os.path.dirname(gs_json), exist_ok=True)
    open(gs_json, 'w').write(stub)
    print('Created stub google-services.json.')

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
