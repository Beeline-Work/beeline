# Schedules and subscriptions frames

These phone-width frames render the real section component with sample schedule and subscription responses. `populated.png` shows a prompt schedule, a workflow schedule, and two event subscriptions. Each row opens its detail page with the shared Stop control. `empty.png` shows the first-use state.

To rebuild the temporary page used for capture, run `node --import tsx scripts/build-subscriptions-frame.ts` from `apps/mobile`, open the generated `evidence/subscriptions/frame.html` at 390 × 900, and take screenshots. The generated HTML and bundle are deliberately omitted from the evidence.
