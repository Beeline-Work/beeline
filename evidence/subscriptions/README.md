# Schedules and subscriptions frames

These 390px frames render the real section and detail components with sample responses. `populated.png` shows a prompt schedule, a workflow schedule, and two event subscriptions; `empty.png` shows the first-use state. `subscription.png` shows Runs, Agent, Where, Why, firing count, and Stop. `stop-confirm.png` shows the second confirmation step before removal.

To rebuild the temporary page used for capture, run `node --import tsx scripts/build-subscriptions-frame.ts` from `apps/mobile`, open the generated `evidence/subscriptions/frame.html` at 390 × 900, and take screenshots. Use `?empty` for the empty list and `?page=subscription` for the detail page; tap Stop subscription for its confirmation state. The generated HTML and bundle are deliberately omitted from the evidence.
