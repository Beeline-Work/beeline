# Schedules and subscriptions frames

These 390 × 900 frames render the real list and detail components with sample Room responses:

- `list.png`: one item in each trigger/action quadrant, grouped as Schedules and Subscriptions.
- `schedule-prompt.png`, `schedule-workflow.png`, `subscription-prompt.png`, `subscription-workflow.png`: the common When, Agent, Where, Does, Stop detail grammar. Workflow actions show the saved steps on the workflow rail.
- `stop-confirm.png`: the second step before stopping a subscription.
- `empty.png`: first-use list.

Rebuild the temporary page with `node --import tsx scripts/build-subscriptions-frame.ts` from `apps/mobile`. Open `evidence/subscriptions/frame.html?page=list` at 390 × 900, changing `page` to `schedule-prompt`, `schedule-workflow`, `subscription-prompt`, `subscription-workflow`, or `empty`. For the confirmation frame, open `?page=stop-confirm` and tap Stop subscription. The generated HTML and bundle are omitted from the evidence.
