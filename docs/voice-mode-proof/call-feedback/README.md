# Reproduction call-feedback-1

The original phone failure was not reproduced. The supplied screenshot shows the
Room after leaving (Join is visible); it cannot establish a live waveform state.
On squire, `adb devices` initially returned no devices. A leased `buzzy_api36`
emulator booted successfully but contained no `app.usebeeline` installation.
No original-call `mode`, `speakerRef`, or incoming-frame recording was obtained.
The following are the brief's isolated stand-ins, not a claim about the original
phone's root cause.

## Reproduced

- Hook: join an active call, receive `speaker:ruby`, leave the bridge's audio level
  at zero, then deliver local microphone levels of 0.1 and 0.5. Before the fix,
  `voice.level` stays zero. This models a speaker signal outliving playback.
- Service: open an authenticated Room WebSocket, subscribe, then call `recordHuman`
  while participation is active. Run without a PostgreSQL LISTEN consumer, modeling
  listener unavailability. Before the fix, the row commits but no `message-delta`
  arrives within two seconds. Neither leave nor a call-card restate occurs.
  Healthy PostgreSQL notification delivery was not shown to fail.

These stand-ins establish two separate failure paths. They do not establish that
park/resume failed in the reported call; park/resume is unchanged.

## Demonstrated

The same hook regression now follows local mic input while bridge audio is zero.
A positive bridge level still takes priority over a louder local microphone.

A Chrome bundle uses the actual `useVoiceCall`, `VoiceBar`, and
`DictationWaveform`, with simulated RTC/provider input. With a retained Ruby
speaker signal, the rendered last bar grows from 9.31836 px to 17.9981 px when
mic input increases. When bridge audio becomes positive, it shrinks to 2.12499 px,
showing agent priority. The call stays joined throughout. No waveform timing or
rendering implementation changed.

The authenticated server WebSocket regression now receives the committed human
row as a validated `message-delta` while the call remains active, without a
leave or card restate and without waiting for PostgreSQL LISTEN recovery.
The publication occurs after transaction commit; PostgreSQL remains the
cross-process fanout path.

## Repeat

```sh
npm test --prefix apps/mobile -- --run sources/buzz/use-voice-call.test.tsx sources/buzz/use-voice-call.browser.test.ts --maxWorkers=1 --minWorkers=1
npm test -w @beeline/server -- --run src/voice-service.integration.test.ts src/voice-room-runtime.test.ts src/voice-providers.test.ts src/voice-target.test.ts --maxWorkers=1 --minWorkers=1
```

Chrome proof requires `/usr/bin/google-chrome` (or `CHROME_BIN`). RTC, STT, and
speech providers are simulated; this does not prove real microphone capture or
provider transcription on a phone.
