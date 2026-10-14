# Spoken target regression

Reproduction voice-name-1: with Ruby selected and Candy in the Room roster,
`hey Candie what do you think?` selected Ruby in the original matcher.
`What does Candy think?` incorrectly selected Candy mid-sentence. Executing
HEAD's original matcher with that roster printed `ruby` and `candy`, respectively.
The report's exact-name behavior was already partly implemented; the reproduced
remaining defects are recognizer spelling and mid-sentence switching.

The runtime regression executes `VoiceRoomRuntime.utterance` with isolated
service, RTC and speech-provider doubles. It performs Ruby → greeting + Candie
→ mid-sentence Ruby → unknown name → opening Ruby. It verifies the agent passed
to transcript persistence, brain generation, playback (including voice), and the
target signal consumed by the existing voice UI for every turn. The resulting
targets are Ruby → Candy → Candy → Candy → Ruby. Audio hardware and live speech
recognition are not covered by this proof.

Run:

```sh
npm test --workspace @beeline/server -- --maxWorkers=2 --minWorkers=1 src/voice-target.test.ts src/voice-room-runtime.test.ts src/voice-providers.test.ts
```

Opening display names and handles, greetings, conservative spelling variants,
unknown names, mid-sentence mentions, ambiguous matches, short-name protection
and complete display-name precedence have direct regressions. Existing runtime
routing owns the transcript prefix, voice and persistent target; existing mobile
VoiceBar renders the server target signal as its selected avatar.

PR #2442 is integrated from main. Its existing policy keeps unnamed speech
silent when several humans share the call; one-human follow-ups retain the
selected target. Opening-name matching applies both to partial target signals
and final reply dispatch. The routing and STT lifecycle regressions from that PR
are retained; its mid-sentence routing expectations now follow this assignment's
opening-address rule.
