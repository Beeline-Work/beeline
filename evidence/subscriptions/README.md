# Schedules and subscriptions frames

These 390 × 900 frames record the original schedules and subscriptions design. The current schedule and workflow layout is shown in [the approved board](../../.lavish/schedule-pages/board.html), rendered from the real screens after the trigger details and workflow steps were separated.

- `main-baseline.png`: the merged main Schedules list rendered with the same font setup for comparison.
- `list.png` and `list-light.png`: one flat list in dark and light mode. This Room's items come first, then each child corner; schedules sort by next run before subscriptions in each place. Line one ellipsizes the action; line two keeps the cadence or event and shortens the agent handle when space is tight, preserving the place. Corner places use a corner glyph and name. All rows stay 64 px tall.
- `schedule-prompt.png`, `schedule-workflow.png`, `subscription-prompt.png`, `subscription-workflow.png`: the original When, Agent, Where, Does, Stop detail grammar. These older workflow-trigger frames also show the saved steps on the trigger page.
- `stop-confirm.png`: the second step before stopping a subscription.
- `empty.png`: first-use list.
- `workflow-from-subscription.png`: the original workflow page reached from a subscription, including duplicated trigger controls.
- `workflow-subscription-stop-confirm.png`: the original workflow page after a Stop subscription tap.

Rebuild the temporary page with `node --import tsx scripts/build-subscriptions-frame.ts` from `apps/mobile`. The page embeds the app's Space Grotesk and IBM Plex Mono font files, as the other mobile browser proofs do. Open `evidence/subscriptions/frame.html?page=list` at 390 × 900; add `&theme=light` for the light list. Change `page` to `schedule-prompt`, `schedule-workflow`, `subscription-prompt`, `subscription-workflow`, or `empty`. For the confirmation frame, open `?page=stop-confirm` and tap Stop subscription. To reach the workflow frame, open `?page=subscription-workflow` and tap the workflow under Does. Run the same command with `--main-baseline` to render the main-branch comparison. The generated HTML and bundles are omitted from the evidence.

Browser measurements after `document.fonts.ready`: list titles and subtitles start at x=45 for all four rows, and the original detail labels, values, Does content, workflow rail, and Stop control share x=16. The computed list text font is `SpaceGrotesk-Regular`.
