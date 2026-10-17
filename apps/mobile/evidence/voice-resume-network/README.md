# Conversation mode resume network recovery

## Reproduction R1

The reported Android screenshot shows an UnknownHostException in both the
Conversation mode alert and composer after background/resume. On this host,
`beeline emulator -avd buzzy_api36 -no-window -gpu swiftshader_indirect` booted
successfully, but `adb -s emulator-5554 shell pm list packages app.usebeeline`
returned no installed app. No signed-in native call was available. Native
background/resume and actual DNS recovery remain unverified.

Closest stand-in: join with the real `useVoiceCall`, park the call, invoke the
live reconnect callback, and reject the state request with the screenshot's
`fetch failed: java.net.UnknownHostException` message. This exercises
`reconcile → checkReply → state`; `join()` returns immediately while an existing
session is present. It identifies a reproducible path, not the actual path on
the reporter's device.

Before the fix, the hook exposes the raw error immediately. The rendered Chrome
proof also fails all three assertions: no error during DNS loss, automatic audio
and microphone recovery, and no raw error reaching the rendered voice surface.
With the fix, all three pass. The proof uses the real hook and VoiceBar, with
simulated native transport, server responses, and reconnect notification. It
renders the hook's error in an alert element and records every non-null error;
it does not mount the complete Room screen.

## Regression and demonstration

From `apps/mobile`:

```sh
npx vitest run sources/buzz/use-voice-call.test.tsx sources/buzz/voice-transport.ios-compat.test.ts sources/buzz/voice-transport.test.ts sources/buzz/voice-resume.browser.test.ts sources/buzz/use-voice-call.browser.test.ts --maxWorkers=1
```

33 tests pass. R1 checks silent recovery, a plain message after four retry waits
(1, 2, 4, 8 seconds), no retries after Stop, and unchanged non-network errors.
Join tests cover Android's `Network request failed` and `fetch failed` variants.
The Chrome proof builds and renders the affected hook and VoiceBar, restores
network availability, and verifies audio plus microphone recovery automatically.

The iOS compatibility tests assert the complete honest unavailable message and
verify unsupported native modules are never evaluated. `COMPAT_RUNTIMES` in
`apps/mobile/scripts/ota-release.mjs` includes `{ platform: 'ios', runtimeVersion:
'31' }`, so the existing OTA plan covers that binary. No release or store
submission is part of this change.
