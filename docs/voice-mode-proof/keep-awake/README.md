# Conversation mode: screen on during the call, call only in the foreground

Feature verification, not a defect report.

## Build

- Tree: this branch after the #2617 revert. Android runtime 39, native fingerprint
  `596e1c7a9afd328d0a9a88ef2b3a3c873e9466a5` (the value recorded with runtime 39 in #2546).
- Normal Android entry (`apps/mobile/index.ts`), `assembleRelease`, x86_64, Hermes.
- Expo updates disabled and cleartext allowed in the local manifest only.
- `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:38598`.
- APK SHA-256 `99a1ca52d7683159970b2570303b565587d3706f134c5e37922ac7615e87ff18`.
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
   `KEEP_SCREEN_ON`, the count of Beeline foreground services, and the server call state.
4. Do one action: Home, the stop button, or the power button.

## Results

- `home.log`: `Awake` with `KEEP_SCREEN_ON` from t=0 to t=29 s, 14 s past the timeout.
  Home pressed at t=34 s; the server shows the call ended by t=38 s through a normal
  `/leave`. `home-call-ended.png`: back in the app, the Room shows "Voice call ended · 0:37".
- `stop.log`: `Awake` with `KEEP_SCREEN_ON` to t=28 s. Stop tapped at t=33 s; the call
  ended and `KEEP_SCREEN_ON` cleared; the screen slept 15 s after the tap.
- `power.log`: power button at t=21 s; the call ended by t=25 s.
- `remote-end.log` (earlier build of the same keep-awake code on runtime 40): the server
  ended an idle call after 60 s of silence; `KEEP_SCREEN_ON` cleared at once and the
  screen slept 15 s later.
- No call, Room open: the screen slept 25 s after the last touch.
- Every sample shows `foregroundServices=0`. During a live call `dumpsys notification`
  listed 0 Beeline notifications.
- `call-idle-24s.png`: the call screen on, 9 s past the timeout.
