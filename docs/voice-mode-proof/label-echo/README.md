# Voice transcript label echo

## Reproduced

Reproduction VOICE-LABEL-1: ask Ruby for a small gift, supply her previous
ceramic-planter answer as assistant context, then ask what to look for.
The live `openai/gpt-6-luna` request with reasoning disabled copied
`Ruby (@ruby) [#beeline/item/previous]:` into its answer when the previous
assistant row carried that label (generation `gen-1792690063-6wPtGq06sduvwnMVkOhK`).
Repeating the same prompt with plain assistant history produced a clean answer
(generation `gen-1792690083-cjwOBAJK2DBuMEwSCEeT`). Requests used sealed vault
injection; no provider secret was read or saved.

The isolated call stand-in uses disposable PGlite, production VoiceService,
runtime and provider adapters, injected STT finals/SSE/PCM, and actual local
LiveKit RTC. The provider returns the copied prefix on every answer.
Baseline source is `3a2693f59`. Synthesis receives
`Ruby (Ruby) [#beeline/item/previous]: A small ceramic planter.` and the
posted answer still contains the original prefix. The speech renderer resolves
the handle but leaves the unwanted label audible. See [baseline.json](baseline.json).

## Demonstrated

Repeat the same utterance and provider output after the fix: synthesis and the
posted transcript contain `A small ceramic planter.`. The RTC partner receives
voiced frames. Assistant history contains plain text; other speakers retain
their labels and references. See [fixed.json](fixed.json).

The runtime regression `VOICE-LABEL-1` repeats two turns with a labeled prefix
and a bare item prefix, splits the prefix across provider tokens, and checks
synthesis, transcript writes and published audio. The provider regressions also
check multiple bare prefixes, multiword names, ordinary prose and a later quoted
label that must remain unchanged. The context regression checks assistant text
and unchanged user/other-agent references.

The provider already collects its response before the runtime begins synthesis.
Cleaning its leading text at that existing boundary requires no extra stream
read, timer, provider call or speech buffer, and handles a prefix split across
SSE deltas. Token callbacks remain timing observations, never speech.

## Timing

On the same prompt (`Ruby, what should I look for?`), four warm-ups precede ten
measured turns per build. The median from recognized end-of-turn to first voiced
server audio was **24.37 ms before and 24.70 ms after**. All samples are retained
in the evidence JSON. The observed difference is 0.33 ms; these samples do not
prove zero latency increase. Providers and STT are controlled stand-ins, so this
does not measure live model generation, physical microphone or speaker latency.

## Repeat

Use `scripts/prove-voice-delivery.ts` with local LiveKit at port 17890 and its
documented development credentials. In an ignored copy of that script, replace
the conversational fixture `Ready.` with
`Ruby (@ruby) [#beeline/item/previous]: A small ceramic planter.`.
For baseline, materialize the three original voice context/provider/runtime files
from `3a2693f59` under temporary filenames, point the baseline runtime's context
import at the baseline context, and use the script's existing
`VOICE_DELIVERY_BASELINE` / `VOICE_CONTEXT_BASELINE` switches.

For each build, POST `/say` with
`{"text":"Ruby, what should I look for?","human":"partner","speechMs":100}`.
Read `/result` after each reply, retaining the latest latency signal after the
warm-ups. Inspect `synthesis`, `transcript`, `brainHistories` and
`frameCounts.received`. Restart the disposable fixture between builds and remove
temporary source files afterward. No production Room, helper or database is used.

## Web acceptance limitation

Squire reached `web.usebeeline.app` in an existing signed-in session and opened
Members. The session subsequently returned to onboarding. Connector status and
vault metadata confirmed the reviewer bypass, but sealed browser-fill rejected
the saved link with `unsupported_credential_type`; drive could not advance it.
A live browser handoff card was posted for sign-in. The requested reviewer-bypass
browser voice test remains outstanding. This branch is not deployed, and this
proof does not claim production browser acceptance.

Workspace preparation, root typecheck and the context/provider/runtime suites
passed (186 tests). The added prefix edge cases and two-turn regression passed
in a final focused run (7 tests). No self-review or merge approval is claimed.

## Punctuated speaker regression

VOICE-LABEL-1 repeated with `Dr. Ruby (@ruby) [#beeline/item/previous]: A small ceramic planter.`
on the pre-revision head `5424d4878`. Both provider and two-turn runtime tests
failed: synthesis and transcript retained the label. The same isolated PGlite,
VoiceService, production provider/runtime and local RTC path now synthesizes and
commits only `A small ceramic planter.`; the partner received voiced audio frames.
See [punctuation-before.json](punctuation-before.json) and
[punctuation-fixed.json](punctuation-fixed.json).

Matched prompt first-audio medians were **38.04 ms before / 31.80 ms after**
(four warm-ups and ten measured samples, controlled providers). This comparison
shows no observed increase, but does not measure live provider or physical-device
latency. The cleaner uses the existing collected-response boundary.

Regressions cover titles, exclamation marks, emoji, bracketed names, exact known
names containing sentence punctuation, token-split prefixes, and later quoted
labels that must remain intact. Runtime tests verify synthesis, transcript writes
and audio publication for Ruby, Dr. Ruby, Ruby! and an emoji name.

The earlier browser sign-in share was closed on Ruby's order. Ruby owns the live
voice check after release; no new production browser acceptance is claimed here.

### Speedy correction replay

Speedy repeated VOICE-LABEL-1 with the same two gift questions and an injected
`Dr. Ruby` label, production VoiceService/provider/runtime, disposable PGlite,
and received local LiveKit audio. The old provider left the label in synthesis
and the committed reply; the revised provider delivered only
`A small ceramic planter.` in both. The partner received voiced frames in both
runs. See [before](speedy-punctuation-before.json) and
[after](speedy-punctuation-fixed.json).

After the test and typecheck processes completed, matched-prompt first-audio
medians were **35.50 ms before / 32.51 ms after**, with four warm-ups and ten
measured samples per build. An earlier run overlapping validation measured
39.78 ms / 47.22 ms; the quieter repeat resolves that timing concern without
claiming a live-provider or physical-device latency measurement. The cleaner
adds no stream read, provider call or speech buffer.

The exact known name and handle are matched first, with regex metacharacters
escaped. The bounded fallback anchors on the handle/item suffix and accepts
punctuation and emoji in names, retaining the sentence-boundary guard for later
quoted labels. Bare opening item references are still removed. Root typecheck
and all three context/provider/runtime suites passed (205 tests).

Repeat using the existing delivery fixture with its conversational reply changed
to `Dr. Ruby (@ruby) [#beeline/item/previous]: A small ceramic planter.` and the
agent name set to `Dr. Ruby`. Use the previous reviewed provider for baseline
and this provider for the fixed run. Run two gift questions, then the same prompt
for the timing samples as described above. No new production browser acceptance
is claimed. Independent review is required because Speedy authored this correction.
