# Android release shrinking

This is an optimization feature, not a defect report. Internal Play proof and the human merge hold remain prerequisites for landing.

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

## Validation status

- Generated Android prebuild has release minification/resource shrinking enabled and optimized default rules.
- Plugin and Play script tests pass, including repeated prebuild, preservation of adjacent rules, version-code archive, mapping upload and missing-map failure.
- Root typecheck, release workflow tests (59), OTA tests (75), branding tests (13), splash tests (5), and native fingerprint gate tests (12) passed.
- Local release AAB built. The first shrunk build crashed on cold launch with `ClassNotFoundException: livekit.org.jni_zero.JniInit` followed by native SIGILL. The unshrunk control installed from its AAB reaches the sign-in screen with an empty crash buffer. The shaded-JNI rule removed that failure, revealing an Expo `SplashScreenOptions` record-conversion NPE. The next build also preserves the `expo.modules.kotlin.records.Field` annotation, the narrow upstream fix in https://github.com/expo/expo/pull/51206. The final build passes the same cold-launch path and reaches both provider login pages with an empty crash buffer. Both comparison builds use the same source, runtime 43 and x86_64 ABI; this is not a Play download-size estimate.
- Local reviewer-bypass web check passed, per Ruby’s updated instruction: this branch’s `apps/server` ran against an isolated PostgreSQL database with a throwaway `BEELINE_REVIEW_SECRET`; this branch’s Expo web export targeted that server. Opening `/review/<secret>` signed in as Play Review, rendered the Beeline Review workspace, opened #general with its composer, and opened Settings showing `@play-review`. See `local-reviewer-room.png` and `local-reviewer-settings.png`. The browser’s notification permission was not granted; this check does not claim notification delivery. Production reviewer browsing is deferred until after release and does not block merge under Ruby’s instruction.
- Emulator criterion 2 passes under brief revision 5: provider pages open, reviewer-bypass sign-in succeeds, a LiveKit call connects and publishes its microphone track, a notification received by the app’s Firebase receiver appears in the shade, and Invite a person opens the Android share sheet with its link. Full Google/GitHub sign-ins and real FCM delivery remain internal-track proof.
- Internal-track Play installation/proof belongs to the release owner and is pending. Nothing has been published from this corner.

## Measured artifacts

`final-fixed.aab` is 61,281,477 bytes versus the unshrunk control's 68,321,867 bytes: 7,040,390 bytes smaller (10.30%). Uncompressed DEX decreases from 58,263,020 to 12,046,100 bytes. Both contain the same JS bundle SHA-256; see `sizes.json`. This comparison uses x86_64 only and does not estimate Play's per-device download size.

The build hashes are in `build-sha256.txt`. The local AABs and full maps remain in `/tmp/beeline-r8-proof/`; they are not committed. The initial bundletool install command used the default ADB server and found no devices; extracting its universal APK and installing through this corner's selected `adb -s emulator-5554` succeeded.

Reproduction R8-STARTUP (implementation regression): install the shrunk AAB via bundletool, force-stop, then cold-launch → first missing shaded JNI class, then Expo record conversion failure. With both narrow keep rules, repeat the same path → sign-in screen; tap Google/GitHub → provider login pages, no crash-buffer entries. Screenshots are attached in this directory. This proves startup and provider handoff, not completed authentication or the authenticated flows.

## Authenticated emulator proof (revision 5)

Reproduction R8-REFLECTION: cold-launch the shrunk release, sign in through `beeline://review/<throwaway-secret>`, connect a voice call, receive a notification, and open Invite a person. The first run logged `NoSuchMethodException` for the install-referrer builder and `ClassNotFoundException` for Expo’s manifest-named `RNHeadlessAppLoader`, despite no fatal crash. Explicit keep rules now preserve both reflection surfaces. Repeat the same path: no ClassNotFound, NoSuchMethod or fatal exception anywhere in the final logcat capture; the crash buffer is empty. See `native-reflection-before.txt`, `device-logcat-scan.json`, `device-crash-buffer.txt` and the native screenshots.

The local reviewer AAB uses the same release/R8 configuration and has byte-identical DEX to the final production-configured AAB (`sizes.json`). Its only test transport adaptations were a local server URL and cleartext permission in the ignored generated manifest. Those adaptations are absent from the final AAB and committed source. The final production-configured AAB retains the unshrunk control’s exact JS hash. Android runtime stays at the already-unreleased 43 while the keep rules are completed; the fingerprint baseline was refreshed for those rules after restoring masked-view’s clean-install manifest.

The reviewer signed into an isolated real branch server/PostgreSQL database. A local fixture agent allowed the normal call UI to connect through the real VoiceService and LiveKit server (1.13.11). The server’s external speech/brain/transcription providers were stand-ins; no external voice credentials or production data were used. `voice-connection.json` records the Android participant becoming active over UDP and publishing its microphone track. This proves native connection/publication, not speech-provider quality or production call delivery.

For notifications, the rooted API 36 emulator injected a test `com.google.android.c2dm.intent.RECEIVE` broadcast into the installed app’s Firebase receiver while the app was in the background. The shrunk Firebase/Expo path received it and displayed the title, body and Beeline icon. This is native receipt/display proof, not Google transport proof. Internal-track testing must use actual notification delivery.

For sharing, Room actions → Members → Add → Invite a person opened Android’s share sheet carrying the minted invite link (`native-outgoing-share.png`). No message was sent to anyone. Incoming ACTION_SEND is unsupported, as confirmed by `inbound-share-result.txt`; revision 5 explicitly excludes adding that feature.

All local proof services were stopped after capture. Internal-track Play installation, completed Google/GitHub sign-ins and the human merge hold remain outstanding.
