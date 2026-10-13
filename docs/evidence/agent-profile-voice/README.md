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

Captain approval was received via firstmate instruction 004 on 2026-10-13. Both Profile and Voice confirmation rows now use the merged `HullDialogActions` from `HullDialog.tsx`.

## Android release proof

The final production-component fixture was built after rebasing the merged alignment/UI policy changes on 2026-10-13. `assembleRelease --max-workers=2 -PreactNativeArchitectures=x86_64` succeeded in 28s. The APK SHA-256 is `b2a204d3e2802d59289cb9fed4e33ad66a5a9918efd9b15d04574dfc29bcbe9d`.

The disposable Android emulator renders a 390dp-wide viewport (780 × 1920 pixels, density 320). These are direct, unedited `adb screencap` captures:

| State | Obsidian | Bone |
| --- | --- | --- |
| Overview | [Profile](android/profile-obsidian.png) | [Profile](android/profile-bone.png) |
| Editing | [Edit](android/edit-obsidian.png) | [Edit](android/edit-bone.png) |
| Voice library | [Picker](android/picker-obsidian.png) | [Picker](android/picker-bone.png) |
| Saved selection | [Save](android/voice-saved-obsidian.png) | [Save](android/voice-saved-bone.png) |
| Another agent | [Milo](android/other-agent-obsidian.png) | [Milo](android/other-agent-bone.png) |

[Preview](android/preview-bone.png) played the real public Fish MP3. Android AudioFlinger reported an active app-owned mono 44.1kHz media track, client PID 6837, track 64, stream 3; [audio receipt](android/audio-preview.txt). Cancel/Save use the shared trailing row. Selecting Calm Narrator and Save closed the picker and changed Emberus's current voice; selecting Dave again left Milo on Calm Narrator.

The fixture imports production Profile/Voice components, with synthetic DTOs and local save receipts. It proves native rendering, preview playback and the receipt-driven UI; database persistence, membership/owner checks and collision-aware Room assignment are covered by server integration tests. It performs no production writes. Only the ignored generated manifest disables OTA updates for this proof so it always runs the embedded fixture. The normal app entry was restored before validation; no native dependencies, runtime pins or shipped configuration changed.

Final checks after restoring the production entry and clean lockfile install: root typecheck; UI policy scanner against `origin/main` (174 registered files); 27 policy tests; all 4461 mobile tests (5 skipped), including the native fingerprint end-to-end guard; 19 server voice tests; 465 API-contract tests; 399 client tests; workflow path lint; and dead-code baseline (91 existing, zero introduced). Android runtime 35 / iOS runtime 33 remain unchanged from rebased main.

### Native Recent work heading regression

The shared heading's flex text collapsed when directly embedded in the horizontal Recent work/Merged PRs row. `AgentProfileView` now gives it a flexible wrapper with assigned width. This is an Android layout fix, not a capture artifact.

`node apps/mobile/scripts/verify-agent-profile-native-heading.mjs <uiautomator.xml>` checks actual native text bounds, positive dimensions, side-by-side placement and vertical overlap. It fails on [the pre-fix hierarchy](android/recent-work-before.xml), which exposes only Merged PRs, and passes on the final [Obsidian](android/recent-work-obsidian.xml) and [Bone](android/recent-work-bone.xml) hierarchies. Both show RECENT WORK at `[32,1660][583,1690]` beside Merged PRs at `[599,1660][748,1698]`. Picker screenshots above are refreshed from the final release APK.
