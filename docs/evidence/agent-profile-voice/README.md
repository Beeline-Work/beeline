# Agent Profile voice approval board

Run `node apps/mobile/scripts/render-agent-profile-voice-proof.mjs` from the repository root. The board is served at `http://127.0.0.1:4187/`; individual frames use `/frame?theme=dark|light&state=picker|edit&agent=second` (all parameters optional).

The approval board is published at https://animals-fishing-dozen-simulation.trycloudflare.com while the local server and tunnel remain running.

The board now bundles the complete production `AgentProfileView` and `AgentVoiceSection`, including shared Settings typography, identity, rows, buttons and both themes. Only transport data is synthetic; the approved mock-only layout transform has been removed. Frame saves are local fixture receipts, not production writes.

The phones have a 390-pixel content width. Both themes show the overview, voice picker, edit state and another agent with a distinct voice. Frames scroll; the picker initially scrolls to Voice. Fish library data was fetched from the same public licensed English library endpoint used by `FishSpeech.prepare` on 2026-10-13. No cloning or upload controls exist. Play uses the provider's public MP3 sample and stops after eight seconds. Save voice updates only that frame's local state; reloading resets it.

Browser validation through `chrome-devtools-axi`:

- Message and Edit share the same top coordinate at 390-pixel width.
- Soul precedes Model / difficulty, which precedes Voice.
- Both themes render without horizontal overflow.
- A Fish public sample loads and the preview control switches to Stop without an error.
- Selecting Calm Narrator Voice and then Save voice updates the current voice and closes the picker.
- The public tunnel renders all eight real-code frames.

Root and mobile dependencies were refreshed and shared SDK packages rebuilt; the full root typecheck passes.

The top-level PNG captures are browser proofs. Native release-build captures and artifact details are recorded separately below. Server persistence, provider catalog/preview API, collision-aware Room assignment and Fish emotion handling are implemented and covered by targeted regressions.

The app-wide alignment approved via firstmate on 2026-10-13 is applied to both mock confirmations: trailing row, quiet Cancel left, primary Save right, shared 44-pixel Button. In profile edit mode, Message remains in its own identity action row; the confirmation row follows the Soul draft.

Captain approval was received via firstmate instruction 004 on 2026-10-13. The app-wide alignment lane owns the shared confirmation-row component; integration follows that lane's delivery.
