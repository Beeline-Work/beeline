# Android release shrinking

This is an optimization feature, not a defect report. Acceptance follows brief revision 8.

## Build configuration

The prebuild plugin enables release minification and resource shrinking, selects the optimized Android default rules, preserves local native modules and LiveKit's JNI callbacks, and keeps notification/splash resources. Debug build settings are unchanged. Sentry native is excluded from autolinking and PostHog is JavaScript-only.

The first local release build reached R8 and failed on optional Netty desktop TLS, certificate-generator and logging classes from AndroidServer. The rules list only those missing classes. Netty detects absent OpenSSL and logging providers; this app's Expo HTTP server does not configure TLS or generate certificates. References:

- https://github.com/netty/netty/blob/4.1/handler/src/main/java/io/netty/handler/ssl/OpenSsl.java
- https://github.com/netty/netty/blob/4.1/common/src/main/java/io/netty/util/internal/logging/InternalLoggerFactory.java
- https://github.com/netty/netty/blob/4.1/handler/src/main/java/io/netty/handler/ssl/util/SelfSignedCertificate.java

Android runtime moves to 43. iOS remains 36. Fingerprint bookkeeping excludes the Android tooling plugin from iOS and explicitly counts its R8 rules on Android; re-recording iOS for that skip-policy correction does not change its binary.

The committed fingerprint baseline is computed after a clean `npm ci --prefix apps/mobile`, before Gradle runs. The masked-view dependency rewrites its own Android manifest during Gradle configuration, removing the legacy package attribute; Expo counts that dependency directory for both platforms. Recording the baseline after the local AAB build incorrectly captured that generated mutation. A clean install reproduced CI's exact hashes on both platforms and corrected the baseline without changing native source or runtime pins.

## Mapping retention

The release job extracts `BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map` from the exact AAB and rejects a missing/empty map. `play-publish.sh` uploads it to Play under the version code returned by the bundle upload, before committing the track change. It copies the map into a version-code directory and exposes the code to Actions. The `android-mapping-<versionCode>` artifact retains `mapping.txt` for 90 days, including when a later Play operation fails. Archive needed mappings before artifact expiry.

For a server native-crash receipt, identify the installed Android version code, download that artifact and run Android R8 Retrace against its `mapping.txt` and the receipt's stack. Do not use a map from another build. No native Sentry capture or Sentry map upload is added.

## Production device proof (brief revision 8)

Jellybean tested commit `8b8a701c505def36732cfe37175a9ac69a99814f` on emulator-5574. The production-configured four-ABI release AAB was installed using a bundletool universal APK signed with a local debug key. Google authentication completed through the browser fallback, not the native account picker.

- Google: Methoxine signed in against production with #general open (`production-google-signed-in.png`, `production-google-account.png`).
- Voice: connected and ended normally after 33 seconds (`production-voice-connected.png`). A nonfatal DATA_TRACK_LOSSY publisher warning occurred during join.
- Notification: Beeline title/body/icon appeared in the shade (`production-notification-shade.png`). A Firebase receiver broadcast on the rooted emulator exercised display; this does not prove real FCM delivery.
- Invite a person: Android's share sheet opened with the invite link (`production-invite-share.png`); no invite was sent.
- GitHub: provider page opened (`production-github-provider.png`). Device sign-in was not completed because using the saved test login needs the owner's passkey approval. Brief revision 8 accepts provider handoff.
- Logs: no ClassNotFound, NoSuchMethod, NoSuchField or FATAL EXCEPTION; crash buffer empty. The five R8 matches are Android system frames and an ART temporary filename, not Beeline failures. See `production-logcat-grep.txt`, `production-logcat.txt.gz`, and `production-run-details.json`.

This production run supersedes the local reviewer-bypass Android proof. No Android build config, keep rules or native code changed during evidence import.

## Historical local web check

The earlier local reviewer-bypass web check passed: this branch's server ran against isolated PostgreSQL with a throwaway review secret, and this branch's Expo web export targeted that server. Opening `/review/<secret>` signed in as Play Review, opened #general with its composer, and opened Settings showing `@play-review`. This is historical and local, not production web proof. The superseded screenshots have been removed. Brief revision 8 accepts this check; this PR changes no web code.

## Validation status

Previously passed: generated release prebuild configuration; plugin and Play mapping tests; root typecheck; release workflow, OTA, branding, splash and fingerprint tests. Mapping validation covers upload under the returned version code, retained artifacts, and missing-map failure. This update imports evidence only.

## Measured artifacts

`final-fixed.aab` is 61,281,477 bytes versus the unshrunk control's 68,321,867 bytes: 7,040,390 bytes smaller (10.30%). Uncompressed DEX decreases from 58,263,020 to 12,046,100 bytes. Both contain the same JS bundle SHA-256; see `sizes.json`. This comparison uses x86_64 only and does not estimate Play's per-device download size.

The build hashes are in `build-sha256.txt`. The local AABs and full maps remain in `/tmp/beeline-r8-proof/`; they are not committed. The initial bundletool install command used the default ADB server and found no devices; extracting its universal APK and installing through this corner's selected `adb -s emulator-5554` succeeded.

Reproduction R8-STARTUP (implementation regression): install the shrunk AAB via bundletool, force-stop, then cold-launch → first missing shaded JNI class, then Expo record conversion failure. With both narrow keep rules, repeat the same path → sign-in screen; tap Google/GitHub → provider login pages, no crash-buffer entries. Screenshots are attached in this directory. This proves startup and provider handoff, not completed authentication or the authenticated flows.

## Four-ABI production artifact

The production device run used a separate four-ABI AAB of 151,959,730 bytes, SHA-256 `ea9dd18e22d57bd96770ff81ba3f3b1b1fd266dad476b4f6e08abb64eb65b0f5`. It is recorded separately in `sizes.json` and `production-run-details.json`; do not compare it to the historical x86_64-only control above. No release was dispatched from this corner.
