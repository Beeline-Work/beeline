# Transcript dividers and reply swipe

The divider refinement is not a defect report. It follows the approved
“Transcript dividers: one rule” mock: corner/PR records lose their top rule,
card facts use the normal hairline, and the footer uses that same hairline.
The card outline, expanded-step separators, and standalone issue rules stay
unchanged. No border tokens are added.

## Reproduction swipe-stuck

The owner supplied Android evidence of a long agent message remaining translated
with REPLY exposed, an empty composer, and the keyboard open. A clean leased
Android emulator was started, but it has no signed-in owner session. Attempts
to build a standalone native replay were interrupted by repeated environment
replacement: the emulator and build processes stopped and dependencies and
temporary files disappeared. The combined intermittent phone failure has not
been reproduced on the emulator. Native screenshots remain outstanding.

The permitted stand-in is the component regression named
“returns an interrupted reply swipe to rest and installs its quote” in
`RoomMessageVariants.test.tsx`. It commits a left swipe without delivering
the opening or closing animation-completion callbacks, checks that close runs,
checks the installed quote target, and checks the eventual reset. It also
renders missing-reference, cross-Room, and draft rows and checks that they
offer no reply action. `message-reply.test.ts` checks that eligibility and
target creation agree and that a hydrated normal row remains replyable.

Before: the regression fails against the original row implementation, which
has no committed-swipe callback; without the Open completion callback neither
close nor reply runs. The existing null-target test confirms the separate
missing-proof path. This establishes both mechanisms in the stand-in; it does
not establish which fired in the owner's screenshot.

After: the committed-swipe callback schedules close after Swipeable's state
update, installs the reply immediately without waiting for animation completion,
and resets after the bounded return animation. A new gesture or unmount cancels
pending timers. Reply affordances and target creation share one eligibility
check; server parent references are preserved rather than fabricated.

## Demonstrated

The production divider components were built with React Native Web and rendered
with production fonts in headless Chrome. The proof expands the steps and
checks that the singleton corner record has no top border. These are standalone
component replays, not screenshots of a signed-in production Room.

| Surface | Bone | Obsidian |
| --- | --- | --- |
| Phone web | [Screenshot](web-390-bone.png) | [Screenshot](web-390-obsidian.png) |
| Desktop web | [Screenshot](web-1280-bone.png) | [Screenshot](web-1280-obsidian.png) |

The native replay entry is `scripts/transcript-dividers-native-proof.tsx`.
It includes a reply screen with a long agent row, ongoing rerenders, a keyboard
input, and a target quote; it can toggle parent proof and invoke the corner
swipe. This harness is not a claim that native verification has completed.

## Validation completed

- Root `npm run typecheck` passed.
- Affected row, reply-target, lifecycle, and browser suites passed (143 tests).
- Design, typography, and existing disclosure browser suites passed (21 tests).
- The interrupted-swipe regression failed on the original row and passed on
  the changed row.
- UI component policy passed.
- Dead-code baseline held (four existing findings, none introduced).

Repeat the web proof from `apps/mobile` with
`npx vitest run sources/components/buzz/transcript-dividers.browser.test.ts --maxWorkers=1`.
For native proof, follow the debug-build/Metro setup in
`../disclosure-top-edge/README.md`, substituting the transcript-dividers native
entry. Use only an emulator leased through `beeline emulator`.
