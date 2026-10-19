# Shipped Android theme audit

Reproduction attempt `SHIPPED-THEME-1`: **not reproduced**. Following Ruby's
corrective instruction `33ad5f74e75228ac2ae1e73fa408cfacdfdb56f11cfd2767a57016eb7bab2264`,
this tests `apps/mobile/index.ts`, rather than replacing it with a proof entry.
PR #2591 was closed and its harness changes reverted. No production fix is
claimed or included.

## Device observations

An isolated API 36 x86_64 emulator ran a locally compiled release/Hermes APK.
The shipped entry, screens, theme module, native runtime and Sentry bootstrap are
unchanged. Generated Android configuration permits local HTTP and disables OTA
replacement. A local test DSN enables the real production `Sentry.init` branch;
its presence was verified in the bundled bytecode. No production Sentry event
or server request is needed for this proof.

- Cold notification: the included instrumentation invokes Expo's real native
  `FirebaseMessagingDelegate` with an in-memory RemoteMessage. It posts an
  Android notification and wakes both registered headless tasks. After the
  instrumentation process exits, `pidof app.usebeeline` is empty. Tapping that
  actual notification starts the app, logs navigation to the intended Room and
  renders its ongoing-call card. [Screenshot](notification-cold.png),
  [native dispatch](notification-native.txt), [routing log](notification-log.txt).
- Headless action: without starting an Activity, instrumentation passes a Reply
  response through Expo's real `runTaskManagerTasks` and registered task consumer.
  Both tasks finish and the reply is committed by the ordinary authenticated
  server operation. [Native result](headless-native.txt), [task log](headless-log.txt),
  [committed message check](headless-result.json).
- Resume: join through the shipped Room's actual Join control, press Home and
  reopen the app. The call card shows `You, Sam`, the same PID (6108) survives,
  and the server still lists both participants. [Screenshot](call-resumed.png),
  [server result](call-result.json).

None of these paths logged the missing-theme error or a native fatal exception.
[Result and APK/source hashes](result.json). FCM network delivery, a physical
phone, and the unidentified bundle from the original crash are not proven here.

The native helper lives only in a generated Android instrumentation APK. It
neither modifies the app JS entry nor configures Unistyles. Its source is
[ThemeStartupInstrumentation.java](ThemeStartupInstrumentation.java). Configure
`testBuildType 'release'` and `testInstrumentationRunner
'app.usebeeline.ThemeStartupInstrumentation'` in ignored generated Gradle files,
then build/install `:app:assembleReleaseAndroidTest`. Run `am instrument -w` with
`mode=notification` or `mode=response` and the disposable Room, Workspace and
parent-message IDs. Finish first-run welcome screens and sign in using the local
review route before the notification tests.

The server is a disposable adaptation of `scripts/prove-voice-budget.ts` using
its ordinary `createBeelineServer`, PGlite, TokenAuth, ReviewAccess, live-row
projection and VoiceService. Ports are HTTP 18097 and LiveKit 17890/TCP17891;
providers return controlled PCM/text. A pending disposable agent command keeps
the call alive while setup runs; the call budget is raised to one hour. No app
identity, session or transport is injected into the shipped client. The native
helper replaces only external FCM delivery and the user's inline-reply gesture.

## Import graph and regression

`shipped-theme-bootstrap.test.ts` runs the actual Expo Babel transform and
Metro inline-require plugin on the shipped entry. Its theme side-effect import
survives and runs before Router and either task installer. A conservative graph
walk follows app-local imports, re-exports, native/platform variants, `require`
and dynamic `import` from Sentry, prefetch, polyfills and notification tasks.
No reachable module imports Unistyles or creates a themed stylesheet.

`RNHeadlessAppLoader` starts the existing application's `reactHost`; it does
not select another JS entry. `expo-task-manager` registers an Android headless
no-op to keep timers alive, then dispatches the named registered callbacks.
Sentry's optional Router-store lookup is lazy; its imports do not import our
call components. Production Metro still has `inlineRequires: true`.

The two new audit checks, six existing appearance checks and four Sentry checks
pass (12 total). Root `npm run typecheck` passes. The new checks pass against
unchanged production code: there is no demonstrated production defect to fix
or before-fix failure to claim.

```sh
cd apps/mobile
npx vitest run sources/shipped-theme-bootstrap.test.ts sources/unistyles.test.ts sources/buzz/sentry.test.ts --maxWorkers=2
```

## Remaining blocker

Sentry event `1c80653433214fae945277f7722162dd` supplies the minified offsets
`anonymous@1:3253804` and `Call@1:134074`, but no crashing-bundle source map or
update ID. Its release tag belongs to the reporting launch. The original native
receipt schema separately carries `releaseSha`, `runtimeVersion`, `updateId`,
app version and crash timestamp; those fields are not present in the Sentry
privacy-allowlisted event. A bounded production-log lookup covering
21:45:03–21:47:30 UTC found no matching receipt.

Next evidence needed: recover that original native receipt or otherwise identify
its crashing update/runtime, then retrieve the corresponding bytecode/source map
and symbolicate the two offsets. A passing current build does not resolve the
original crash. No guessed theme or Sentry-filter change was made.
