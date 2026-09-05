# Android signing — release keystore

This directory used to hold the **release keystore** for Buzzy's sideloading
APK directly. The repo went public, so the keystore and its passwords were
purged from the tree and from history; the key itself is unchanged and lives
only in repository secrets (backed up off-machine):

| Secret                            | Contents                       |
|-----------------------------------|---------------------------------|
| `ANDROID_SIDELOAD_KEYSTORE_B64`   | the keystore file, base64-encoded |
| `ANDROID_SIDELOAD_KEY_ALIAS`      | key alias (`buzz-release`)      |
| `ANDROID_SIDELOAD_STORE_PASSWORD` | keystore password               |
| `ANDROID_SIDELOAD_KEY_PASSWORD`   | key password                    |

**Never rotate this keystore.** An installed sideload app can only be
upgraded in place by a build signed with this same key — a new key means
every existing install must be uninstalled and reinstalled.

## Usage

`scripts/android-build.sh` requires all four `ANDROID_SIDELOAD_*` variables to
be exported in the environment. It decodes the keystore to a temporary file,
exports its path as `ANDROID_SIDELOAD_KEYSTORE_PATH`, and deletes it again on
exit; `scripts/patch-android-signing.sh` wires the prebuilt Gradle project's
`signingConfigs.release` to read the path/alias/passwords from those same
environment variables at build time — none of them are ever written to a file
in the tree. Run the full chain with:

```sh
export ANDROID_SIDELOAD_KEYSTORE_B64=... ANDROID_SIDELOAD_KEY_ALIAS=... \
       ANDROID_SIDELOAD_STORE_PASSWORD=... ANDROID_SIDELOAD_KEY_PASSWORD=...
npm run apk:release
```

Fetch the values from the repository secrets (or ask whoever holds the
off-machine backup) — they cannot be recovered from the tree or its history.

Output APK: `android/app/build/outputs/apk/release/app-release.apk`