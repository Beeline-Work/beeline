# Android signing — release keystore

The Beeline Android sideload signing key was rotated on **2026-10-15** after
the old keystore and its passwords were found exposed in public git history.
The old key remains exposed in that history and must never be reused.
The replacement PKCS12 keystore lives in the Trusty Squire vault under service
`android-sideload-signing`, label `sideload-2026-10-15`, and in these repository
secrets:

| Secret                            | Contents                       |
|-----------------------------------|---------------------------------|
| `ANDROID_SIDELOAD_KEYSTORE_B64`   | the keystore file, base64-encoded |
| `ANDROID_SIDELOAD_KEY_ALIAS`      | key alias (`beeline-sideload-20261015`) |
| `ANDROID_SIDELOAD_STORE_PASSWORD` | keystore password               |
| `ANDROID_SIDELOAD_KEY_PASSWORD`   | key password                    |

Rotate a compromised signing key and replace its fingerprint in both
app-links files and `scripts/app-associations.mjs`. Keep the Play Store
fingerprints unchanged. A new key requires existing sideload installs to be
uninstalled and reinstalled; no sideload APK had been downloaded when this
rotation was authorized.

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

Use the vaulted replacement credential through an approved secret-handling
route for local builds. GitHub Actions consumes the repository secrets;
GitHub does not return their values. Never recover signing material from
public history or write secret values into the repository.

Output APK: `android/app/build/outputs/apk/release/app-release.apk`
