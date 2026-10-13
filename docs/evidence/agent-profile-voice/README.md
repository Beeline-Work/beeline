# Agent Profile voice approval board

Run `node apps/mobile/scripts/render-agent-profile-voice-proof.mjs` from the repository root. The board is served at `http://127.0.0.1:4187/`; individual frames use `/frame?theme=dark|light&state=picker|edit&agent=second` (all parameters optional).

The approval board is published at https://animals-fishing-dozen-simulation.trycloudflare.com while the local server and tunnel remain running.

This mock bundles the real React Native Web `AgentProfileView`, `ProfileIdentity`, `ProfileActions`, `SettingsRow`, buttons, identity marks and theme tokens. A mock-only esbuild transform moves the model display after Soul, splits model name and thinking level into readable rows, and adds the Voice fixture. Production components, server behavior and persistent data are unchanged pending approval.

The phones have a 390-pixel content width. Both themes show the overview, voice picker, edit state and another agent with a distinct voice. Frames scroll; the picker initially scrolls to Voice. Fish library data was fetched from the same public licensed English library endpoint used by `FishSpeech.prepare` on 2026-10-13. No cloning or upload controls exist. Play uses the provider's public MP3 sample and stops after eight seconds. Save voice updates only that frame's local state; reloading resets it.

Browser validation through `chrome-devtools-axi`:

- Message and Edit share the same top coordinate at 390-pixel width.
- Soul precedes Model / difficulty, which precedes Voice.
- Both themes render without horizontal overflow.
- A Fish public sample loads and the preview control switches to Stop without an error.
- Selecting Calm Narrator Voice and then Save voice updates the current voice and closes the picker.
- The public tunnel renders all eight real-code frames.

The mobile typecheck was attempted. It currently fails on pre-existing SDK build drift (missing voice/push exports in installed `@beeline` dist) and an absent `livekit-client` dependency; the new mock files reported no type errors. These prerequisites will be resolved before implementation validation.

PNG captures here are browser proofs, not native Android release screenshots. The server persistence, provider catalog/preview API, collision-aware Room assignment and Android release-build evidence follow approval. Firstmate's acknowledged follow-up also adds Fish emotion-tag guidance to voice-mode prompting, preserves tags for speech, and removes them from the visible transcript without an extra request or buffering delay.

Approval is required by the launch brief before implementation or a PR.
