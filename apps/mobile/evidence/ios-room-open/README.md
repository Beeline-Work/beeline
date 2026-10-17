# iOS runtime 31 Room-open crash

Verified 2026-10-17 UTC on an Xcode Release simulator build of native source
`885f7b90`: **Beeline 0.2.21, runtime 31**, React Native 0.83.1, Hermes,
x86_64, iOS 26.4. This is a reconstruction of the App Store native build,
not an App Store IPA installed on a simulator. Xcode 26.4.1 built and signed it
on the Mac build host. Every Room proof used the reviewer's own **Beeline
Review** Workspace, never the owner's Workspace.

## Reproduction and bisect

| JavaScript on the same native 31 binary | Result |
| --- | --- |
| Original embedded JS (`885f7b90`) | Proof Room transcript and composer open |
| Exported v0.1.58 (`923d7a17dad5ad3693a1f07b2ced586cddef553b`) | Tapping proof Room closes the app |
| Exported v0.1.71 (`24c48a7670d9e81b3c4a6dc2b8b1bc03fe1860c4`) | Same Room-open failure |
| Actual production OTA v0.1.72, fetched by expo-updates | Same Room-open failure and native emitter invariant |
| v0.1.72 source (`06b9d272c`) plus this fix, production Hermes export | Proof Room and general Room open; proof Room opens again after back navigation |

The actual production update was
`01a14702-21f6-777f-8d0a-cd825b19f1ac`, created
`2026-10-16T23:18:04.534Z`. The simulator's expo-updates SQLite record showed
runtime `31`, status `1` (ready), and successful launch count `1` after the
second launch. Maestro then observed the Room list, tapped the proof Room,
and failed to find the transcript after the process closed. No OTA was
published, rolled back, or changed for this investigation.

The regression entered in `ca6bac24e` (2026-10-14 20:39:45 UTC), whose first
release tag is **v0.1.58**. Thus v0.1.58 also fails this native replay; the
last historical device receipt is not evidence that opening a Room was safe.

## Exact cause

Room mount calls `subscribeVoiceResume`. Its `import('react-native')` reaches
Metro's production `metroRequire.importAll`, which reads every enumerable
export. Reading the React Native barrel's lazy `PushNotificationIOS` getter
evaluates `Libraries/PushNotificationIOS/PushNotificationIOS.js`, including:

```js
new NativeEventEmitter(NativePushNotificationManagerIOS)
```

`PushNotificationManager` is absent from this native binary. The iOS
constructor enforces a non-null native argument. Android does not enforce
that invariant, explaining the platform difference.

The first native log error is:

```text
Unhandled JS Exception: Invariant Violation:
`new NativeEventEmitter()` requires a non-null argument.
```

An unminified v0.1.58 replay with a diagnostic hook only at the emitter
constructor identified the module being evaluated:

```text
NATIVE_EMITTER_NULL_TRACE Error
  at NativeEventEmitter (main.jsbundle:25061:198)
  at anonymous (main.jsbundle:51655:64)
  at loadModuleImplementation
  at guardedLoadModule
  at metroRequire
```

Line 51655 is the `PushNotificationEmitter` constructor in PushNotificationIOS.
Subsequent native reports include SIGABRT/Hermes GC allocation frames and
SIGSEGV while draining microtasks; those follow the module-evaluation error.
`client-error-report.ts` also dynamically imported the same barrel, so
reporting another failure could trigger the same invariant and hide the
original diagnostic. A Promise catch or React error boundary cannot make
this native module initialization safe.

LiveKit's missing native dependencies are a separate compatibility hazard:
they were lazy and did not cause the Room-mount failure. The fix checks iOS
WebRTC, LiveKit and all background-audio methods before importing LiveKit,
so unsupported binaries get an App Store update message when entering
Conversation mode. Android keeps its existing voice initialization path.

## Fix and automated coverage

- Named static `Linking` and `Platform` imports avoid Metro namespace
  enumeration in Room subscriptions, notification routing and diagnostics.
- `sources/config/nativeRuntimeImports.test.ts` executes the installed Metro
  production runtime against an optional native getter and scans production
  source ASTs for dynamic React Native barrel imports. It caught all three
  unsafe call sites before the fix.
- `sources/buzz/voice-transport.ios-compat.test.ts` verifies that missing and
  intermediate iOS native capabilities cannot evaluate LiveKit, and that a
  supported runtime starts and closes audio. Existing transport tests cover
  Android, cleanup, resume routing, parking and native idle timers.
- Both regression files run in the mobile OTA leg's candidate validation,
  which must pass before production promotion. Existing compatibility
  targets and native pins stay unchanged.

The native failure is reproduced with actual production OTA. The fixed
candidate was replayed without OTA enabled to pin its exact bytes, using
the same native executable and native-style exported assets (the iOS asset
manifest includes 1x/2x/3x images; the two extra 4x navigation images listed
by the generic export are not selected on this simulator). Fixed HBC
SHA-256:
`972cf21cb9b5331156eca317b7d261e71a5546272c26f156ea526a353af8e372`.
Its release version marker is `v0.1.72-ios-room-fix` (local proof only).

Maestro [open-room.yaml](open-room.yaml) and [multi-room.yaml](multi-room.yaml)
passed transcript/composer assertions, including opening `#general` and
reopening `#proof`. [Screenshot of the fixed Room](runtime31-room-open.png).
The [tray.yaml](tray.yaml) flow also passed: open Tray, return to Rooms,
and open `#proof` again.

Local validation: root `npm run typecheck`; 96 focused tests including the
80 OTA release tests; workflow path validation. The full mobile run passed
4,564 tests, with two existing browser tests timing out at five seconds;
both files passed on a single-worker rerun (four tests).

## Repeating the native proof

1. Archive the native source above, install mobile dependencies, build shared
   SDK dist using `npm run eas-build-post-install`, run Expo iOS prebuild and
   pod install, then build the `Beeline` scheme in **Release** for a dedicated
   simulator. Use Xcode-managed simulator signing (`CODE_SIGNING_ALLOWED=YES`,
   `CODE_SIGN_IDENTITY=-`); disabling signing breaks SecureStore. Preserve the
   Xcode-generated entitlements when resigning a replay app. Manually adding
   restricted keychain entitlements produces a fixture launch failure.
2. Verify `CFBundleShortVersionString=0.2.21` and
   `EXUpdatesRuntimeVersion=31`. Keep production channel and updates enabled
   for the production-fetch leg. A fresh rebuild embeds today's timestamp:
   expo-updates correctly skips production bundles older than that timestamp.
   Backdate **only this disposable fixture's embedded app.manifest** and clear
   only its simulator `.expo-internal` cache before the first production
   launch. Preserve reviewer identity storage. Launch twice to download then
   select the production update, and inspect the update database to confirm it.
3. Sign in with the private reviewer fixture without logging its secret,
   select Beeline Review, then run `open-room.yaml` using that simulator's
   explicit UDID. Capture native unified logs before later crash-recovery
   symptoms obscure the first exception.
4. For a pinned source replay, run `NODE_ENV=production npx expo export
   --platform ios`, overlay its HBC and the corresponding native-style assets
   (`expo export:embed --assets-dest ...`) on a copy of the signed native app,
   disable updates only in that copy, resign preserving entitlements, install,
   and run the same flows. Do not substitute Expo Go or a current-runtime build.

Direct EAS manifest requests need `expo-platform: ios`,
`expo-runtime-version: 31`, `expo-channel-name: production`,
`expo-protocol-version: 1`, and
`accept: multipart/mixed,application/expo+json`. Asset downloads must use the
signed headers from the response's `assetRequestHeaders`; omitting them can
produce HTTP 403 and is not evidence that the phone's updater cannot fetch.

## App Store 0.2.22 and delivery

The successful v0.1.58 native artifact records **0.2.22 build 92, runtime 35**,
Apple processing state `VALID`, delivery/build ID
`16c17a6e-d3b1-47fd-86be-87f3ddb92b29`, IPA SHA-256
`b938111798422ef794f7f43d1f88792666022125ea18cf6aa980732e47a2fc67`.
The artifact comes from [unified release run 38662034119](https://github.com/Beeline-Work/beeline/actions/runs/38662034119).

Releasing 0.2.22 alone is not a fix for the unsafe barrel import: it uses
the same React Native version and does not add the legacy push-notification
pod. Its newer voice capabilities solve a different native compatibility
problem. Runtime 31 can open Rooms with the JS fix; a store upgrade is not
required for Room access. The fixed candidate still needs firstmate's normal
merge/release and a production iOS receipt after promotion. This worker did
not release anything.
