# NET-WASTE-1 — stop wasted client reads

The originating production audit captured the signed-in release web app. Its baseline was identical Workspace responses (98 reads; 111,622 decoded bytes), later-starting offscreen Workbench requests after leaving Settings (3 reads; at least 196,620 decoded bytes), and an eager parent transcript on desktop corner entry (1 read; 44,138 decoded bytes). Parent corners remain required and are unchanged.

This branch is unpublished. The Squire browser confirmed the existing production session is signed in at `/beeline/channels`; it serves the release, not this checkout. Releasing is outside this assignment. The closest stand-in is a locally bundled Chrome navigation fixture using the production Workbench hook, parent-read hook and Workspace invalidation predicate, with synthetic server answers and route/live seams. It exercises list → Settings → list → Settings → corner → work pane. It demonstrates visible Settings and pane content, not just internal function calls. It does not claim a new production capture, native proof, compressed transfer savings, or production latency.

Run from `apps/mobile`:

`npx vitest run sources/test/client-network-waste.browser.test.ts --maxWorkers=1`

The same browser fixture was run first against the old Workbench module plus the previous unconditional list-listener and parent-read behavior, then against the fix. The old run fails the regression; the fixed run passes.

| Window | Before | After |
| --- | --- | --- |
| Unrelated global events while viewing list | Workspace reads (98; 1,666 fixture bytes) | Workspace reads (0; 0 fixture bytes) |
| Relevant membership, Workspace and reconnect signals | Workspace reads (3; 141 fixture bytes) | Workspace reads (3; 141 fixture bytes) |
| Workbench events after leaving Settings | Offscreen Workbench reads (3; 222 fixture bytes) | Offscreen Workbench reads (0; 0 fixture bytes) |
| Reopen Settings after hidden changes | Refreshes (0) | Refreshes (1; 74 fixture bytes) |
| Corner before work pane opens | Parent transcript reads (1; 59 fixture bytes) | Parent transcript reads (0; 0 fixture bytes) |
| After explicit work pane open | Total parent transcript reads (1; 59 fixture bytes) | Total parent transcript reads (1; 59 fixture bytes) |

Fixture byte counts are decoded serialized synthetic answers, not production savings. The browser fixture does not mount the complete chat route; route wiring is additionally typechecked. Focus regressions exercise retained mounted Settings screens, independent visible consumers, reconnect while hidden, and one reconciliation on return. List tests enumerate membership, Workspace, reconnect and legacy events alongside unrelated events.

The fix preserves the shared socket and Room/corner-list reads. An already-started Workbench request may finish after blur; no later live-driven request starts with zero visible consumers. Hidden scopes are marked dirty; their next focus reconciles once. Imperative reads no longer acquire permanent holds. The parent read is gated by a visible desktop work pane and late replies cannot replace another parent's view.
