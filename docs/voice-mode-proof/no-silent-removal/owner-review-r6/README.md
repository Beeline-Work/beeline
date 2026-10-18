# Revision 6 owner review

These full-size, unedited Android screenshots use the normal Expo Router Experiments Room, its real server-indexed transcript and existing composer. They supersede revision 5's rejected notice/action presentation. Bone is the selected app theme; no screen or product chrome was replaced.

| State | File | Artifact |
| --- | --- | --- |
| Solo, filled stop glyph; accessibility End call | solo-live.png | 18f4fcdb-1bbc-4f26-a774-e032c1471fa9 |
| Two humans, same glyph; accessibility Leave call | group-live.png | 5f132423-137d-46fb-a068-19d4ba619343 |
| Existing tip slot, Ending in 12s | countdown.png | c252606d-9dc9-4fa7-9d25-ed608dfe8b25 |
| Ended reason line, no actions, composer restored | ended-card.png | d58bbcd4-bf97-4178-ba9c-72ee6075722d |

## Demonstrated

Reproduction `multi-human-silence-1` retains the existing original/fixed listener-removal proof. This continuation exercises revision 6 through the actual Android Room with the local seed server (`scripts/serve-voice-room-review.ts`). It uses disposable PGlite, local LiveKit, a Node RTC participant as Sam, Android as Alex, and deterministic STT/brain/tone-TTS substitutes. The app's temporary local-auth boot module was restored afterward. No production account, credential, Room or release was used.

Both humans joined. Sam left, so Alex's stop control changed its accessibility label to End call; Sam rejoined and it returned to Leave call. The glyph stayed the same. Initial call work held the call open. Finishing it began the quiet window. The warning arrived at 45 seconds; the capture shows 12 seconds remaining. Human speech then cleared the warning and reset the window without waking Ruby. The call ended 60.039 seconds after that last activity deadline calculation; `result.json` records a cancellation, the new deadline and the stop signal. Its ended card reads `Voice call ended · 3:18 · No one spoke for 60s`, with no Join or other button, and the normal composer returns.

Pressing the composer's existing voice-entry control (accessibility label Conversation mode) created call `42e66b28-65ae-43df-a950-867a1b732817`. The prior call `1f0ac0dc-bd79-418a-9dde-bef8b3f82da1` remained ended, with its silence cause. `room-after-restart.json` is the server DTO for that transition. The composer's separate speech-input microphone retains dictation behavior.

## Implementation and checks

The server sends an absolute deadline and its clock timestamp after 45 seconds of quiet. Android renders the remaining seconds; reaching zero cannot end a call locally. Speech/playback or pending call work clears the server deadline. Reconnect receives the current deadline. The runtime checks quiet state once per second and retains the existing five-second lease renewal and 120-second transport grace. Warning signals do not trigger heartbeat/refresh work.

The end cause is stored on the voice call, then projected onto the phone's card DTO through read-side enrichment. The existing stored System card and wording remain unchanged; the System-message lock passes without a lock edit. There is no private notice, banner or Start new call button. Explicit last-human leave omits the cause.

Verified: 12 stop/quiet-window/warning regression cases, 18 service integration cases, 17 System-lock cases, and 66 focused mobile/design cases, plus root typecheck and no new dead-code findings. The remaining runtime cases passed in the broader run before the focused quiet-timer correction. The clock-stepping integration tests suppress real interval scheduling and invoke the real quiet checker deterministically.

## First audio

`first-audio.json`: original median **10.775 ms**, revision 6 median **12.746 ms** (five samples each after a warm-up). Both used the same local RTC and deterministic providers, with validation jobs stopped and the Android app stopped while its emulator stayed idle. Samples overlap; the observed median difference is 1.970 ms. These measure accepted voiced audio publication, not live-provider or physical-speaker latency. No buffering, provider wait or new awaited stage was added to the speech/turn pipeline.

The owner's merge hold remains. Ruby reviews these captures before owner review.
