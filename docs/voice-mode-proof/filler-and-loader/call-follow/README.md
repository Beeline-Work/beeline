# CALL-FOLLOW-1: call entry retains the automatic unread landing

## Reproduced

Baseline: PR #2729 head `186438bacad14c1f809008e6d190d1a42de9fc6f`.

1. Open Experiments with unread history. The normal Room screen lands on its first unread message. Do not drag, scrub, jump to another message or press the newest chevron.
2. Join the ongoing call from its normal header. Alex uses Android; Sam uses Node RTC. Both remain in the same call.
3. Submit the deterministic spoken request `Ruby, the live transcript must show this new spoken request.` through the real voice runtime. Its recorded answer is `Ready.`
4. The Room remains at the old unread position. [Before](before-unread-call.png) shows the running call and old rows after that request. The live socket delivered both canonical message deltas, so this is not a suspended subscription. Pressing newest makes the rows appear and subsequent arrivals follow correctly.

The automatic unread landing clears the controller's pinned flag. Starting a call previously did nothing to leave that landing, so the ordinary arrival rule correctly kept holding history. This is the reproduced path; no claim is made that every reported frozen-call case has this cause.

## Demonstrated

Repeat those steps with this change, again without touching the transcript. [The initial unread position](automatic-unread-before-join.png) is unchanged before joining. Call entry now requests the existing newest destination, unless a reader gesture or explicit history destination chose history. [After](after-new-message.png) shows the new human message and the agent's answer while You and Sam remain in the call. Later arrivals use the existing pinned-tail rule.

Drag back into history during the call, then submit `Ruby, keep my history position while this new request arrives.`. Compare [history before](history-before-arrival.png) and [history after](history-after-arrival.png): the same text retains its position, and the existing new-message chevron gains its badge. No repeated call-state update forces a landing. Controller regressions also cover deliberate wheel, scrubber and message-jump navigation before joining, and returning to newest afterward.

## Proof setup and limits

Android API 36, task-owned emulator `emulator-5562`, existing runtime-39 debug APK, current JavaScript through Metro. The normal Expo Router Room screen, transcript, composer, voice hook, native WebRTC and RTC audio are used. Disposable PGlite data and local authentication replace production accounts. STT input is injected at the real runtime's utterance entry; deterministic brain/tone TTS replace network providers. No production data or provider calls are needed.

The existing `scripts/serve-voice-room-review.ts` fixture was copied for this run, using HTTP 18897, Metro 18898 and LiveKit 18890/18891/18900–18920. Its blanket `voice-transcript` invalidation wrapper was removed. Instead, PGlite's `beeline_live_v1` notifications go through `PostgresLiveListener.rebroadcast`; socket upgrades go through `createBeelineServer` with the real PhoneService and LiveHub. The notification projector and canonical message-delta protocol are therefore the production path. The unchanged broad-refresh fixture also follows at the tail; it was not used as proof of a defect.

Run the copied fixture with `SILENCE_PROOF_ANDROID_FIRST=1 SILENCE_PROOF_HOLD=1`. HOLD keeps initial work pending so the call does not end during captures. Open Experiments, join, then POST `/say` with the texts above. The temporary boot supplies the seeded Alex identity and local origin before Expo Router loads. Its Room reads retain the existing streaming fetch implementation; voice requests use native global fetch because the old debug binary's Expo fetch interface returned an empty body for that path.

The installed binary also predates `configureStop` and its generation arguments. A temporary foreground-only JavaScript adapter omitted that notification-stop method and called the old native start/stop signatures. Native RTC, microphone and audio remained real. This proof does not test notification actions, background calls or a new native binary. Both the adapter and authentication boot were restored/removed afterward; no native, fingerprint or release files changed. The old binary hit one native reload crash; reopening succeeded. A development-only lossy data-channel warning also appeared during join; reliable call state and demonstrated audio/transcript continued, and its overlay was dismissed before the final capture.

Validation: 91 tests passed across six controller, follow, component, jump and boundary suites. Root typecheck passed after removing the temporary proof adapter. The existing `maintainVisibleContentPosition`, tail threshold and arrival behavior are unchanged; the only new landing occurs on joining a call.
