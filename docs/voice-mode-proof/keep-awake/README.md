# Screen stays on during a Conversation mode call

Feature verification, not a defect report.

## Build

- Normal Android entry (`apps/mobile/index.ts`), `assembleRelease`, x86_64, Hermes.
- Expo updates disabled and cleartext allowed in the local manifest only.
- `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:38598`.
- APK SHA-256 `2f999b701fea553910c6777e27dba50ddef1a371c04f27b098fb89ad9a3bdebf`.
- Android API 36 emulator (`buzzy_api36`), `stay_on_while_plugged_in=0`.

## Fixture

`node --import tsx scripts/prove-voice-keep-awake.ts` runs the real server, auth, Room,
voice service and RTC over a disposable PGlite database. Brain, STT and speech are silent
doubles. LiveKit v1.9.12 ran locally in dev mode on port 27940.
Sign-in used `beeline://review/isolated-keep-awake-proof-only`, then the Room list.

## Steps

1. Set `screen_off_timeout` to 15000 ms.
2. Tap Conversation mode in the Room composer. Do not touch the screen.
3. Every 4 s, record `dumpsys power` wakefulness, whether the app window has
   `KEEP_SCREEN_ON`, and the server's call state.

## Results

- No call, Room open: screen `Asleep` 25 s after the last touch.
- `remote-end.log`: screen `Awake` with `KEEP_SCREEN_ON` from t=0 to t=53 s.
  At about t=55 s the server ended the call ("No one spoke for 60s").
  `KEEP_SCREEN_ON` cleared at once; the screen slept at t=73 s.
- `hangup.log`: screen `Awake` with `KEEP_SCREEN_ON` to t=28 s. The stop button
  was tapped at t=32 s; `KEEP_SCREEN_ON` cleared at once; the screen slept
  15 s after that tap.
- `call-idle-35s.png`: the call at 0:35 with the screen still on, 20 s past the timeout.
