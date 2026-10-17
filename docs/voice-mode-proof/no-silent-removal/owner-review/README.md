# Revision 5 owner review

Full-size Android captures from the normal Expo Router Room route (`BuzzChatSurface`), its server-indexed transcript, `ConversationComposer`, `VoiceBar` and `VoiceCallCard`. Bone is the app's selected theme. These are unedited screenshots, not HTML or a component harness. The debug menu button and development log overlays were disabled for capture.

- `solo-live.png`: one human, End call.
- `group-live.png`: two humans, Leave call.
- `call-end-notice.png`: private, dismissible notice after the server quiet window.
- `ended-card.png`: after dismissal; duration, Start new call, no Join.

The Room is a local seeded Experiments Room with Alex, Sam and Ruby. `scripts/serve-voice-room-review.ts` runs its real PhoneService, VoiceService and runtime against disposable PGlite and local LiveKit. A Node RTC participant is Sam; Android is Alex. No production identity, credential or Room was used. The STT/brain/TTS providers are deterministic substitutes, as in the existing reproduction. The app entry and normal production auth were restored after capture.

## Capture setup

Start local LiveKit on 17890 (devkey/secret, localhost-only test credentials) as in the parent proof. Run `SILENCE_PROOF_ANDROID_FIRST=1 SILENCE_PROOF_HOLD=1 npx tsx scripts/serve-voice-room-review.ts`. It serves the normal phone Room/Workspace reads and live invalidations on 18097. Start Metro from apps/mobile with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:18097`, port 18098. In a temporary, ignored boot module loaded before `expo-router/entry`, set `monolithSession.identityId` to the seeded `a`-repeated-64 identity, `authorization` to a dummy local token, and `fetch` to native fetch. This substitutes local authentication only; no screen or component is replaced. Open Experiments in the normal Room deck.

Join the call. Capture group controls. POST `/partner-leave`, capture solo controls, then POST `/partner-rejoin`. POST `/work-finish` to finish the call-initiated work and let the real server quiet window elapse. Capture the notice, dismiss it and capture the ended card. Press Start new call; inspect the normal Room DTO to confirm a different active call ID and that the previous call remains ended.

## Verification

The UI uses existing shared Buttons, theme colors and type roles. The notice is local hook state, delivered only by a trusted silence stop or a session-authorized state receipt. A server receipt is recorded only on participant rows present at quiet termination; people who left earlier and stale sessions receive no reason. Explicit Leave/End and transport loss do not create the notice. Dismiss removes it, a new join clears it, and it is not stored in the transcript.

First-audio timing remains the paired controlled RTC measurement in `../paired-first-audio.json`: original median 40.984 ms, revised median 42.809 ms. This UI/termination-receipt addition adds no work to the turn pipeline. Those figures are controlled local audio publication timings, not live-provider or physical-speaker measurements.

## Review artifacts

- Solo: `f5a6f1ad-14a9-4ceb-a94f-6a74bc842fb6`.
- Group: `3ab3e93a-7758-4f31-9cac-040d0bc12eab`.
- Private notice: `5a8beb9f-1c9d-40da-bb96-019e57d23ae5`.
- Ended transcript: `4f9e4355-875d-476d-94a2-056d527abba3`.

`room-after-restart.json` records the real Room response immediately after pressing Start new call: call `f213e436-4503-4fa4-8a2e-c20021cf9a95` is active while its predecessors remain ended. Its subsequent real 60-second termination is shown in the notice/transcript captures. The earlier 6-second card is an explicit leave during mode-switch verification; the 1:00 cards are actual quiet-window ends from repeated checks.
