# Spoken report limit proof

Reproduction SPOKEN-150 (2026-10-20): a call-origin order completes with a
120-word knowledge answer. Refresh the call runtime, match the committed report
to the order, claim it, recheck the caller and target, then synthesize and
publish audio. Before the change, only the first 15-word sentence reaches
synthesis, followed by “The rest is in the chat.” After the change, all 120
words reach synthesis without the suffix. The report text stays intact.

The closest isolated stand-in is the runtime report path in
`apps/server/src/voice-room-runtime.test.ts`, named `Reproduction SPOKEN-150`.
A live call on a phone was not exercised: this worktree has no isolated live
provider/RTC fixture running. The stand-in controls database responses,
synthesis bytes and RTC, while using the actual report routing, claim, speech
formatting and audio publication code. It proves the text delivered to synthesis
and first frame publication, not live provider or phone speaker latency.

Run:

```sh
npm test -w @beeline/server -- src/voice-room-runtime.test.ts -t 'Reproduction SPOKEN-150'
```

Using the same 120-word input and seven fresh runtimes for each version,
wall-clock report refresh to first captured audio frame measured:

| Version | Median | Seven samples (ms, sorted) |
| --- | ---: | --- |
| Before | 0.381 ms | 0.339, 0.361, 0.362, 0.381, 0.384, 0.446, 5.402 |
| After | 0.452 ms | 0.426, 0.444, 0.444, 0.452, 0.464, 0.528, 1.129 |

The 0.071 ms median difference is below one millisecond in this controlled
path. These measurements do not establish unchanged network synthesis latency.
The provider, phrase splitting and audio playback code are unchanged.

Additional regressions cover a complete 120-word first paragraph, a 400-word
paragraph ending at the last sentence within 150 words, a short opening plus
detail, a one-line status, empty speech, and the sixfold character/CJK caps.
The service integration test verifies the call-origin command's new instruction.
