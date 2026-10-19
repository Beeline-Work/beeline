# VOICE-SEARCH-1: quick searches and short spoken reports

This is a feature, not a defect report. Addressing and targeting are unchanged.

The voice router has `search_web` and `search_history` alongside ordinary `order`.
Each search carries the router's short `spoken_line`; real Luna responses can
omit assistant content during a tool call, so the acknowledgement is a required
argument rather than relying on prose in the prompt. The acknowledgement plays
while a search runs. Search execution has a 2.5-second abort/race deadline;
a failure or timeout routes the original human request through ordinary dispatch.
The next router call receives at most 8,000 characters of untrusted evidence and
has no tools. Ordinary conversation still uses exactly one router call.

History search calls `searchInstitutionalHistory` with the committed human source,
output Room and answering agent. Its existing access policy remains intact.
The group-call regression puts the same marker in a shared Room and a Room one
caller cannot read; only the shared message returns. No new access rule is added.

The existing `voice_orders` relation privately marks commands when they are read
by the agent. The human transcript does not acquire that instruction. Reports
retain their full chat text. Playback uses the first short paragraph or whole
sentences within 25 words, followed by “The rest is in the chat.” Reports wait
for human and agent speech to finish, then recheck presence and the caller's
current target. Departed or retargeted reports are marked handled without audio.

## Provider comparison

`providers.json` records live calls using the owner's existing OpenRouter and
Groq keys, injected by Trusty Squire without returning credentials. Both APIs
searched the same public question about Japan's capital. These are end-to-end
vault-proxy round trips, including proxy and network overhead, rather than pure
provider timings.

| Provider | Successful samples (ms) | Median (ms) | Other result |
| --- | --- | --- | --- |
| OpenRouter Luna + Parallel turbo web plugin | 2005, 3088, 2387 | 2387 | — |
| Groq GPT-OSS-20B + browser_search | 4755, 5882 | 5318.5 | Third request: HTTP 429 in 390 ms |

OpenRouter is selected. Its slower sample reinforces the need for the deadline
and ordinary-order fallback. Groq's rejected request is excluded from its success
median. Live production-prompt checks also confirm that greetings and repeating
words use no tool, while web/history requests choose the respective search tool
and provide a short spoken line.

API references: [OpenRouter web plugin](https://openrouter.ai/docs/guides/features/plugins/web-search),
[Groq browser search](https://console.groq.com/docs/tool-use/built-in-tools/browser-search).

## Repeat

The isolated service fixture is `scripts/prove-voice-search.ts`. It uses a
disposable PGlite database, ordinary command claim and report publication, and
real LiveKit transport. STT finals, web results and provider SSE/PCM are controlled
stand-ins. It never touches production identities, helpers or databases.

Build `apps/mobile/scripts/voice-delivery-android-proof.tsx` as the ignored Android
Gradle entry, with the loopback API `http://10.0.2.2:18097`, cleartext enabled,
Expo Updates disabled and x86_64 selected. Use at most two Gradle/Metro workers
and a 4 GiB Gradle heap. Start a dedicated LiveKit v1.9.12 on 17890 (RTC TCP
17891 and UDP 17892–17902), then run:

```sh
SILENCE_PROOF_ANDROID_FIRST=1 node --import tsx scripts/prove-voice-search.ts
python3 scripts/prove-voice-search.py branch
```

The driver uses a Beeline-leased emulator named `emulator-5554`, the real Join
control and agent avatar, native RTP observations, and the server's first-audio
signal. It saves observations and screenshots beside this file. For the main
comparison, materialize the main runtime as temporary
`apps/server/src/.voice-delivery-baseline.ts`, restart with
`VOICE_DELIVERY_BASELINE=1`, and run the driver with `baseline`. Remove the
temporary module afterward. Every server run starts with a fresh database.

## Demonstrated on Android

`baseline.json` and `branch.json` contain five ordinary call turns each, including
the first turn after the Android participant joins. Main at `64f9a1a9b` measured
21.505 ms median to first server-published voiced audio; the branch measured
21.471 ms. These controlled-provider native RTC runs meet the requested median
criterion; the tiny difference is not evidence of a speed improvement. They do
not measure live-provider latency or a physical phone speaker. A first unequal-load
comparison is retained in `diagnostic-unequal-load.json`: its branch run overlapped
history-test migrations, so both versions were rerun without those tests.

`functional.json` records a separate final run through the same built Android
voice controls and real native RTC. It proves a fast web search reaches audio
without dispatch, a forced slow search and a failed search each dispatch exactly
one ordinary command whose report arrives, and a long report speaks only its
opening while the phone Room read keeps the full text. Controlled STT StartOfTurn
and EndOfTurn events hold and release human speech. A report waits for quiet;
a real avatar tap changes the runtime target, and the final target assertion
proves that report is handled without speech. Leaving during speech likewise
handles the waiting report silently. Native inbound RTP/energy observations
accompany the synthesis and full transcript evidence. Run this check without
repeating the latency samples with `--skip-latency`.

The group history-access and private call-mark regressions live in
`voice-service.integration.test.ts`; voice provider/runtime regressions cover the
2.5-second cutoff, abort-ignoring searches, ordinary one-call conversation,
shortened reports, quiet waiting, target changes, departures and interrupted
report deduplication. Existing institutional-history regressions also pass.
Root `npm run typecheck` and `npm run lint:workflow-paths` pass.
