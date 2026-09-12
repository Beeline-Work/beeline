# Composer v2 evidence

These are actual Expo web screens backed by `apps/server/src/index.ts`, its normal schema migrations, and an isolated scratch PostgreSQL database. Working receipts and current memberships were seeded to make the states reproducible; these captures do not claim to show a live model run. The held-corner image is the explicitly authorized exception described below.

- `before-phone.jpg`: captain-supplied phone reference. Its composer already appears on one row.
- `before-corner.png`: baseline desktop corner, with the original composer/progress components. The unbounded default textarea puts the placeholder above the controls; the corner has no working-line stop.
- `phone-idle.png`, `phone-running.png`, `phone-queue.png`: 390×844, idle, authorized working line, and queued-send draft.
- `phone-held.png`: authorized Room hold with text, brass control.
- `phone-member.png`: ordinary non-requester member, no stop affordance.
- `phone-stopped-and-sent.png`: successful cancellation followed by sending the draft; the ordinary stopped line remains.
- `phone-corner.png`: real corner screen. `phone-corner-held.png`: isolated component fixture, explicitly labeled in the image.
- `desktop-idle.png`, `desktop-running.png`, `desktop-corner.png`: 1440×900, including the embedded corner composer.

The held corner uses the actual `ConversationComposer` and `TurnProgressLine` in an isolated Expo entry with an authorized working-turn fixture. It avoids the router’s `Illegal invocation` error encountered during full-corner automation. No held-state override was necessary: Playwright exercised the real timer with pointer input: move to the visible control, mouse down, wait 650 ms, screenshot, then drag away and release. Other captures used chrome-devtools-axi. The baseline temporarily used the original components from the task's starting commit; the files were restored before validation.

Focused tests cover tap versus hold, authority loss, drag cancellation, cancel-before-send ordering, shared Room/corner rendering, and desktop Enter/Shift+Enter behavior. Server integration tests cover requester and current owner/admin authority, refused ordinary members, and demotion.
