# Status canvas and queued-message proof

Android API 36, 1080×2400 at 420dpi, task-owned `buzzy_api36` emulator started with `-read-only -port 5586`. Every device command targeted `emulator-5586`. Captures run Hermes release JavaScript built by `assembleRelease -PreactNativeArchitectures=x86_64`, with the emulator-only debug signing key. OTA loading was disabled only in the generated proof manifest. Native Unistyles, Reanimated, SVG, fonts, and the real `ConversationComposer` render these frames. Final frames use the app's `react-native-keyboard-controller` keyboard avoidance and `composerBottomPadding` with the actual safe-area inset.

The [native fixture](../../scripts/status-band-native-proof.tsx) mounts the shipped status components and presentation selector above an inverted, scrolled transcript. Its controls supply local working/settled/no-active-turn facts and a queued-message flag; pressing the real composer's send arrow sets that flag and clears the field. No backend commands, production Room, or real Ruby turn are changed. The baseline fixture reproduces the original pending-command filter and the predicate that hid the working presentation. Baseline frames use the same status components and composer, with React Native's height keyboard avoidance and 32dp bottom padding. Their closed-keyboard composer bounds match the final frames.

The original slot painted 33dp of the intended 42dp status area. The remaining 9dp above the row exposed transcript fragments. Every baseline frame has 8,755 non-canvas pixels in that upper strip; every final working, settled, and working-plus-queued frame has zero. The sampled baseline lower join was already opaque. The new 8dp overlap extends into the composer's existing top padding to guard that join against independent native rounding.

[Pixel audit](pixel-audit.json), reproducible with `python3 apps/mobile/scripts/status-band-frame-check.py`, checks the full-width upper air and composer join, plus transcript ink across the band outside the fixed glyph cell. All final frames pass, including the keyboard-open send. Native `measureInWindow` reports composer y=777.5238dp closed and 465.1429dp with the keyboard; after Android's 136px window offset those are y=2177px and 1357px. The ordinary glyph and status ink are allowed; transcript fragments are not.

Firstmate's final steering removes “Waiting for @agent” entirely on phone and web. Accepted commands remain silent when there is no running turn. The old waiting state is therefore compared with the final pending/no-line state below. Existing pending-command storage and the silent resend are untouched.

| State | Bone before | Bone after | Obsidian before | Obsidian after |
| --- | --- | --- | --- | --- |
| Working | [Before](android-before-working-bone.png) | [After](android-after-working-bone.png) | [Before](android-before-working-obsidian.png) | [After](android-after-working-obsidian.png) |
| Waiting → pending with no active turn | [Before](android-before-waiting-bone.png) | [After](android-after-pending-bone.png) | [Before](android-before-waiting-obsidian.png) | [After](android-after-pending-obsidian.png) |
| Settled | [Before](android-before-settled-bone.png) | [After](android-after-settled-bone.png) | [Before](android-before-settled-obsidian.png) | [After](android-after-settled-obsidian.png) |
| Working + second message queued | [Before](android-before-queued-bone.png) | [After](android-after-queued-bone.png) | [Before](android-before-queued-obsidian.png) | [After](android-after-queued-obsidian.png) |

[Second message sent through the real composer, keyboard open](android-after-send-keyboard-obsidian.png): the field is cleared, the queue flag is set, and Ruby's working presentation keeps its first-turn clock.

Validation: 117 focused tests across status selection, component rendering, Room wiring, composer layout, scroll follow, Room-open geometry, and both design lints; mobile typecheck; native proof release build; ordinary app-entry release build with all generated proof overrides restored. The two paint-coverage tests fail against the original canvas (33 instead of 42), and the Room wiring guard rejects the original waiting-line renderer. These are native component/layout fixture frames, not a full signed-in Room or iOS device proof.
