# Dictated-send timing collection

Instrumentation only: recognizer shutdown, uploads and fallback deadlines keep
existing behavior. No baseline or latency improvement has been measured yet.

## Reproduction DS1

On a physical Android phone, open a Room, tap the mic, speak naturally, then tap
Send. Measure the time until the server accepts the message. Run a short take
(about five seconds) and a continuous long take (about forty-five seconds) with
real human speech. The known waits are not yet a measured reproduction.

Use a build containing this instrumentation. Capture the JS console on the
phone, or with a connected Android development device:

```sh
adb logcat -v time ReactNativeJS:I '*:S' > dictated-send.log
```

Filter for `[dictation-timing]`. Each JSON row contains only a process-local
`take` number, a fixed `stage` and milliseconds since recording began. No message
text, audio, URIs, names, Room IDs or event IDs are logged. Subtract `send_tapped`
from each later stage. The last `audio_closed` is the last audio closure;
`native_end` measures recognizer shutdown independently.

`upload_start` is immediately before fetch, after JS compression.
`upload_response` is response headers received, including server and Groq wait;
it is **not** an isolated measurement of upload completion. `groq_text_back`
follows parsing a successful transcription response. Fetch does not expose
request-body completion, so isolated upload completion still needs server-side
receive timing or transport support. Multiple pieces/retries produce multiple
request rows.

`fallback` marks use of on-device text instead of Groq. `server_accepted` is
recorded only after the outbox's publish operation succeeds, not when an
optimistic message is displayed. Correlation is memory-only and expires after
two minutes; disconnected sends can therefore have no acceptance row.

Record phone model, OS, build commit, connection, take duration, Send-to-native-end,
Send-to-last-audio-close, request timings, Send-to-Groq, Send-to-server-acceptance
and whether fallback fired. Keep the same phone, connection and spoken passages
for the after measurements. Do not substitute synthesized audio or an emulator
for the required human/phone proof. No iOS proof has been collected.

Behavior changes must wait for the baseline to be posted in the corner, per
brief revision one. Propose the fixed Groq deadline from those measurements.

## Current validation

The instrumentation passes the existing speech input, transcription, dictated
send composer, phone-to-server dictation stand-in and outbox runtime suites,
plus timing privacy/correlation tests (122 tests). The stand-in uses generated
WAV data and a Groq fixture; it proves the code path, not real-voice latency,
recognition accuracy or boundary safety. No behavior changes are included yet.

Device routes checked: local `adb devices -l` returned an empty device list;
`tailscale status` showed the owner's Galaxy A15 offline. Connector discovery
and status expose API/browser services, not a live phone microphone or human
speaker. A hosted device or emulator cannot supply the specified human-voice
baseline. Bring a physical phone online for the collection above.
