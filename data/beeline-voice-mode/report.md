# Beeline voice mode delivery

PR: https://github.com/Beeline-Work/beeline/pull/2404. The captain approved the native build
and a full release including store; firstmate owns merge and release. Implementation, captured evidence and pending
phone proofs are documented in [the voice runbook](../../docs/voice-mode.md).

## Native runtime and the path to the phone

This implementation requires a new native binary. The React Native LiveKit
transport adds `@livekit/react-native-webrtc` and its Expo config plugins;
JavaScript OTA cannot add their native WebRTC/audio-session code to an installed
binary. Android moves **33 → 34**; iOS moves **32 → 33**. This follows
[LiveKit's Expo requirements](https://docs.livekit.io/home/quickstarts/expo) and
[Expo's native-runtime compatibility rule](https://docs.expo.dev/eas-update/runtime-versions/).
Keeping the old pin would falsely advertise compatibility with a binary missing
those modules.

A WebView transport could plausibly avoid this bump: Beeline already includes
`react-native-webview` and microphone permissions, so an HTTPS page could run the
LiveKit web SDK and bridge targeting/transcript events to the native voice bar.
That is an alternative implementation, **not a proved OTA release path**.
Microphone permission handling, autoplay/user activation, audio routing, call
interruptions and lifecycle behavior need proof on the actual installed Android
and iOS binaries. WebView has its own
[media-capture permission controls](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md#mediacapturepermissiongranttype).
The approved delivery now uses the native implementation.

For the current implementation, the release path is:

1. With the native build approved, firstmate releases the merged SHA
   through `unified-release.yml` with an explicitly approved store track. A
   runtime-pin change intentionally refuses the ordinary OTA-only release.
2. The Android leg builds the new AAB on EAS and submits to the chosen Play
   track; the iOS leg builds on the Mac runner and submits to TestFlight.
   Submission is followed by the store/operator's rollout step. These are the
   existing [release](../../docs/release-pipeline.md) and
   [store submission](../../apps/mobile/docs/store-submission.md) paths.
3. Install/update Beeline from that track on the phone (Play testing/production
   for Android, TestFlight/App Store for iOS). Only then can the phone use the
   native voice path and receive subsequent OTA updates for its new runtime.
   Run the remaining real-phone voice/latency proof on that installed build.

The previous Android 33 and iOS 32 pins remain in `COMPAT_RUNTIMES`; old installs
are not universally cut off from supported OTA JavaScript updates. They cannot
receive the missing native modules through OTA or use this native voice path.
Aura 2 is the only speech provider; Workspace Settings has no provider choice.
Flux and Aura use Workers AI, whose daily quota can prevent a live rerun until
reset or an owner-approved paid plan. Historical Aura server measurements and
their limits are recorded in [the voice runbook](../../docs/voice-mode.md).

For the Aura-only cleanup, Ruby authorized the live acceptance proof after
deploy when an existing local or staging environment cannot load the provider
keys. Start one real Android voice call, confirm audible Aura, record time to
first audio, and compare the same measurement with current main or production.
Latency must not increase. On failure, immediately revert the cleanup through
the repository merge gate and report failed. Check Workspace Settings on the
production web app through the reviewer bypass as well. Do not change production
secrets or create a credential injection route.
