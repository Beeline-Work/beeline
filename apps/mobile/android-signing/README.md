# Android signing — release keystore

This directory contains the **release keystore** for Buzzy's sideloading APK.

## ⚠️ SECURITY CAVEAT

This repo is **PRIVATE** and the keystore is committed only for automated
sideload builds. **Before any public distribution** (Play Store, betatesting,
open-source release) **rotate this keystore**:

```sh
keytool -genkey -v -keystore new-release.keystore \
  -alias buzz-release -keyalg RSA -keysize 2048 -validity 10000
```

Do not reuse these credentials for anything outside this private repo.

## Credentials (for CI / local build only)

| Field       | Value            |
|-------------|------------------|
| Keystore    | `release.keystore` |
| Alias       | `buzz-release`   |
| Store pass  | `REDACTED`    |
| Key pass    | `REDACTED`    |

## Usage

Gradle reads these via `android/signingConfigs.release` in the prebuilt project.
The `apk:release` npm script in `package.json` runs the full chain:

```sh
npm run apk:release
```

Output APK: `android/app/build/outputs/apk/release/app-release.apk`