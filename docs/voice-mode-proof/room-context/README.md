# Voice sentences, speakers and room context

Reproduction VOICE-CONTEXT-1 follows the approved call bugs. The original call
cannot safely be replayed against production participants. The stand-in uses the
production runtime and provider adapters, disposable PGlite identities, actual
local LiveKit RTC, controlled STT finals and provider SSE/PCM, and a built Android
fixture rendering the production call hook and VoiceBar.

## Reproduced

Post Goosey's picnic suggestion with `picnic.txt` and a human's Picnic plan card.
Ask Ruby for a reply whose SSE stream ends with `finish_reason: length` after
`One complete sentence. Then a trailing fragment`.

At baseline `127a44f42`, synthesis receives both the complete sentence and
`Then a trailing fragment`. The brain history omits Goosey's turn, its attachment,
and the human's card. [Baseline evidence](context-baseline.json) contains the
actual provider request history and synthesis text. The original phone report
supplies the waveform failure; the baseline transport meters only the local mic.

## Demonstrated

The reviewer found a capped abbreviation case under VOICE-CONTEXT-1:
`The appointment is confirmed. Dr. Smith will explain the` previously sent
`The appointment is confirmed. Dr.` to synthesis. The repeated production
provider/runtime proof with disposable PGlite and real local LiveKit now sends
only `The appointment is confirmed.`; see [abbreviation evidence](abbreviation-fixed.json).
Run the fixture with `VOICE_CAPPED_REPLY='The appointment is confirmed. Dr. Smith will explain the'`
and POST `{}` to `/context-probe` to repeat. Provider regressions also cover
titles, initials and dotted abbreviations, and the runtime regression asserts
the exact synthesis input. Ambiguous abbreviated endings are conservatively
omitted from capped replies, without additional provider calls or waits.

Repeat the identical posts and utterance with the fixed runtime. Synthesis
receives only `One complete sentence.`. The brain history includes Goosey by
name and handle, the attachment title and URL, and Picnic plan with its URL.
[Fixed evidence](context-fixed.json) records the same path passing.

The posted-item tool is offered only for explicit requests to read an item. Its
service checks the live call, caller access and agent eligibility, then restricts
reads to undeleted messages/cards or attached text in this conversation. The
integration proof reads the shared message and text attachment, rejects another
Room's message and an arbitrary external URL, and uses the second brain call to
produce a short spoken summary. Text is bounded; binary and oversized attachments
are refused without fetching external media URLs.

Web and native meter regressions exercise local, agent and other-human sources,
select the loudest amplitude, and release meters on mute/unsubscribe/leave. A
rendered VoiceBar check preserves the agent's speaking label and live waveform
while the local microphone is muted. Existing echo-filter regressions pass.

## Repeat

Materialize the baseline runtime and providers from `127a44f42` into temporary
`apps/server/src/.voice-delivery-baseline.ts` and
`apps/server/src/.voice-context-baseline-providers.ts`. These are proof inputs,
never committed source. Start local LiveKit on 17890 with development-only
`devkey`/`secret`, RTC TCP 17891 and UDP 17892–17902. Run the disposable fixture:

```sh
VOICE_DELIVERY_BASELINE=1 VOICE_CONTEXT_BASELINE=1 VOICE_CONTEXT_PROOF=1 \
  SILENCE_PROOF_ANDROID_FIRST=1 node --import tsx scripts/prove-voice-delivery.ts
python3 scripts/prove-voice-context.py --mode baseline
```

Restart the fixture without the two baseline variables for the fixed run, then
run the driver with `--mode fixed`. The driver asserts the wrong and passing
results. No production helper, identity or database is used.

For Android, build `apps/mobile/scripts/voice-delivery-android-proof.tsx` as the
ignored Gradle entry, with loopback cleartext allowed and Expo Updates disabled
in the generated manifest. Use two Gradle/Metro workers and a four-GiB Gradle
heap. Install the x86_64 fixture on a Beeline-leased emulator, grant microphone
access, join the call, mute the local microphone, and request five seconds of
controlled agent audio through `/say`. Capture the production waveform and
inbound native RTC statistics. Generated native configuration is never shipped.

## Timing

Run `python3 scripts/prove-voice-context.py --mode baseline --latency --round 1`
on a fresh baseline fixture, then repeat fixed on a fresh fixture. Stop builds
and tests before measuring. For additional confidence, repeat in reverse order. Each sample starts at the
runtime's recognized end-of-turn boundary and ends at first voiced server audio;
the native RTC partner receives its latency signal. Four warm-up replies precede
ten measured `Ruby ready?` replies per fixture. Providers and STT remain controlled
stand-ins: these timings do not measure live model token latency, STT endpointing,
or physical phone speaker latency.

The matched quiet-host run measured median first voiced server audio at **48.84 ms
before and 36.43 ms after**. All ten samples per build are retained in
[baseline timings](latency-baseline-1.json) and [fixed timings](latency-fixed-1.json).
There is no observed median regression in this controlled run. Host timing varies;
these samples do not establish equal live-provider token latency.

## Validation

- Workspace preparation and root typecheck passed.
- Server provider/runtime/service/context regression suites: 200 passed.
- Final provider/service checks after the tool-description and response-bound
  changes: 62 passed.
- Mobile hook/browser/native-meter/VoiceBar checks: 35 passed; the subsequent
  VoiceBar run including muted remote speech: 10 passed.
- Android x86_64 release fixture built successfully.

### Native speaker waveform

The built Android release fixture joined the real RTC call. The local microphone
was muted before asking Ruby to reply with five seconds of controlled PCM. The
[earlier frame](agent-speaking-1.png) and [later frame](agent-speaking-2.png) show
the muted mic, Ruby's speaking frame and nonzero brass waveform. [Native receipt](android.json)
records joined state, no error, decoded inbound audio energy and APK hash. These
are actual device captures of production components, not rendered mockups.

The reverse-order repetition measured **44.33 ms before and 37.29 ms after**.
Across both runs, the median of all twenty samples per build was
**44.89 ms before and 36.68 ms after**. Both build orders are retained; the
baseline's second run includes a 449 ms host outlier. These are observed
controlled-provider results, not a guarantee about every live call.

Dead-code baseline passed with no introduced findings.


## Reproduction VOICE-FILLER-1

The approved stand-in is the production opening-name function; no call is needed.
Before this addition, `openingVoiceName('um hey Candy help', agents)` returned
`undefined`. The same direct source invocation now returns Candy. Stacked fillers,
phonetic spellings, no-name speech, a four-word bound, filler names/handles,
full display names, ambiguity and the short-name guard have regression coverage.
The matcher performs bounded local work without another provider call or timer.
