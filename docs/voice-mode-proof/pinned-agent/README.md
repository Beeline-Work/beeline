# Voice reply and private pin proof

Reproductions R1, R2 and R3 use the approved stand-ins retained in brief revision 4.
Production provenance below is accepted by that revision; no further log investigation is needed.

The matching market question occurred at **21:19 UTC / 17:19 Eastern**, rather
than 17:19 UTC. Retained logs show **quick `search_web` followed by `answer`**
for trace `c276b6ac-fcca-417e-9794-4e545a37a0fc`; no heavy order was recorded
for this call. Database checks confirm an own-name prefix on the acknowledgement
and answer, and the date hedge on the answer committed at 21:19:39 UTC.
Timing rows identify serving build `b82f0f7fbcf524bf0f92d18345cd83754983869a`.
Both quick and heavy paths remain fixed and tested as directed.
[Redacted production correlation](production-path.json) contains only routing
metadata and boolean transcript checks, without conversation text.

## Reproduced

- **R1:** the original runtime posted and synthesized `**Ruby:** Let me look.`
  and `Ruby: Here is the answer.` unchanged. The original provider also retained
  `Ruby: Hello.`. The regression tests failed against those original modules.
- **R2:** the original quick and heavy assembled prompts did not contain
  `Results dated today are current`. Both prompt regressions failed against
  the original provider and command-reader modules.
- **R3:** the original hook joined with Ruby selected, rather than null. The
  original runtime ignored the new unpin signal, leaving Alex's selection set.
  Both regressions failed before the fix.

## Demonstrated

- **R1:** the runtime posts and synthesizes clean quick answers and search
  acknowledgements. A dispatched, claimed heavy request posts a clean answer
  through `DaemonService`, and `PhoneService.readRoom` returns that answer.
  The report playback test feeds `Ruby:` into the heavy report queue and verifies
  that synthesis receives only the answer. Unit coverage includes mixed case,
  bold labels, quoted labels, regex characters, and preservation of names in
  the middle and quotations in the answer.
- **R2:** quick search and response prompts retain the injected current UTC date
  across midnight, and include the current-evidence instruction. A dispatched
  heavy voice command includes today's UTC date, the same instruction, and the
  instruction not to start with its name.
- **R3:** the Android driver joins a real native LiveKit call using the production
  hook, agent strip and voice bar. It verifies each native target/speaker state
  before capture: join unpinned, pin Ruby, tap Ruby to unpin, pin and speak,
  move to Goosey, and clear using the Unpin link. An unnamed question while
  pinned is committed as `@ruby Ready?`. Hook and server tests separately verify
  two-person isolation and restoration of existing unpinned routing.

The disposable fixture uses PGlite and controlled model SSE/PCM. It holds the
call open for capture; no production identity, helper, provider key or call is
used. Theme buttons and the call header belong to the proof harness. The dock
is the production UI. Physical speech recognition and phone-speaker latency
are not claimed.

| State | Bone | Obsidian |
| --- | --- | --- |
| Default | [capture](bone-default.png) | [capture](obsidian-default.png) |
| Pinned | [capture](bone-pinned.png) | [capture](obsidian-pinned.png) |
| Pinned and speaking | [capture](bone-speaking.png) | [capture](obsidian-speaking.png) |
| Pin moved | [capture](bone-moved.png) | [capture](obsidian-moved.png) |
| Tap cleared | [capture](bone-tap-unpinned.png) | [capture](obsidian-tap-unpinned.png) |
| Link cleared | [capture](bone-link-unpinned.png) | [capture](obsidian-link-unpinned.png) |

[Native state assertions](android.json) and [build provenance](build.json).

## Repeat

Build `apps/mobile/scripts/voice-delivery-android-proof.tsx` as the generated
Android `react.entryFile`, with cleartext enabled and Expo Updates disabled only
in the generated manifest. Use x86_64, two Gradle/Metro workers and a 4 GiB heap.
Install on a Beeline-leased API 36 emulator and grant microphone permission.
Start local development LiveKit on 17890 with RTC TCP 17891, then run:

```sh
VOICE_PIN_PROOF=1 SILENCE_PROOF_ANDROID_FIRST=1 node --import tsx scripts/prove-voice-delivery.ts
python scripts/prove-voice-pin-android.py --device emulator-PORT
```

The driver requires Pillow and locates the avatar row from the fixture's face
pixels so it follows the pin line's layout change. Native observations confirm
the selected agent and speaker before every capture.

## Validation

- Root `npm run typecheck`. The reply unit suite also passes its literal-name cases.
- Server voice provider, reply, runtime, service integration and daemon access
  suites pass. The heavy report playback regression also passes.
- Daemon completion-latency suite: six passing tests, preserving the existing
  write-round-trip guard.
- Mobile hook, VoiceBar and design suites: 51 passing tests. The hook suite also
  confirms an explicit unpin is sent when reconnecting without a pin.
- `npm run lint:ui-components` and `git diff --check`.

The shared cleaner adds no timer, stream read, provider call or database round
trip. Heavy output obtains its own name in the existing membership query before
both atomic and transactional message paths. Roll out the updated bridge with
the mobile changes: an older bridge does not understand explicit unpin.

## First audio

Same prompt, `Ruby ready?`, same disposable native RTC service, controlled
provider SSE and PCM, two warm-up turns then ten samples per variant.

Median first voiced audio: **25.99 ms before**, **25.94 ms after**.

[Before samples](latency-baseline.json), [after samples](latency-fixed.json).
These are server captureFrame/RTC signal measurements, excluding real model
network latency and physical phone playback. Small CPU-sensitive samples cannot
prove zero latency under all production loads. No fixed wait or network round
trip was added.

All exploratory runs remain available: the concurrent-build samples were
28.81 ms before and 46.26 ms after; a fixed run during Android startup was
42.40 ms. Stage logs showed that latter run was already slower at human commit,
before reply cleanup. The final comparison was repeated with the emulator
settled and without a concurrent build or test suite.

Measure the active fixture with
`python scripts/measure-voice-pin-latency.py fixed` (or `baseline`). The baseline
used the original runtime and provider from `a33ca7b68`, materialized as the
fixture's temporary `.voice-delivery-baseline.ts` and
`.voice-context-baseline-providers.ts` modules, with
`VOICE_DELIVERY_BASELINE=1 VOICE_CONTEXT_BASELINE=1`. Remove those temporary
modules before validation or committing.
