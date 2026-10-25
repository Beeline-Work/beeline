# GitHub connect card padding

## Reproduced

Reproduction R-GITHUB-PADDING: open the existing `scripts/github-card-proof.tsx`
native scene, choose Normal, and switch Theme between Bone and Obsidian.
The active Connect GitHub card has a bottom inset of 8 points while the top
and sides use 16. The screenshots reproduce that uneven inset; this checkout
already has some bottom padding, rather than literally zero.

The source feedback item is `fb_0420b52a327bc5597bb80514` (read through the
vaulted read-only Neon route). The add-own-agent journey's production account
session is unavailable on this clean emulator: no Beeline app or signed-in
account was installed. The existing native card scene is the brief's permitted
stand-in. It renders the production RepositoryOnboardingCard, TranscriptCard,
fonts and themes with fixture navigation and account operations. This is not
an end-to-end production onboarding recording.

## Demonstrated

R-GITHUB-PADDING uses the same native scene and themes after the fix.
Only the active native Connect GitHub footer opts into a 16-point bottom inset.
The title, copy, button position, and all other padding are unchanged; the card
extends downward by 8 points. Errors, settled records, starter tasks, installation
cards, non-actionable cards and web keep the default footer.

`before-bone.png` / `after-bone.png` and `before-obsidian.png` /
`after-obsidian.png` show native captures on the corner emulator.
`error-before.png` / `error-after.png` show the unrelated error card retaining
identical pixels in its rectangle (x 40–1040, y 565–1115), while the independent
Connect GitHub card below it gains only bottom padding.
`web-before.png` / `web-after.png` are identical full-page screenshots from
local Expo web in Chrome at 1200 by 850.

The existing scene's developer controls and floating tools badge are proof
harness UI. No production entrypoint or Metro config changes are committed.
To run it, follow `../github-card-return/README.md`'s Local fixture instructions
and use `http://localhost:18765/?state=Normal` for web.

## Validation

Root typecheck, shared UI component policy, repository card and cold-start
resume tests, and both design lints pass. The card test exercises Android, iOS,
web, installed, settled, starter and unauthorized states so only the intended
card receives the opt-in. No copy or other card spacing is changed.
