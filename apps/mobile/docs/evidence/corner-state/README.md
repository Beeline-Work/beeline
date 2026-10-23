# Corner state proof

Reproduction CORNER-STATE. The baseline state function at `98eadcc6c` reports running CI as Review and a turn ended ten seconds ago as Idle. The approved model requires Waiting and Working respectively.

The isolated server proof in `apps/server/src/corner-attention.integration.test.ts` exercises `PhoneService.readCorners`, `PhoneService.readChats` and `getCornerRestoreState` against the same committed facts: active worker → Working; short gap → Working; active reviewer → Review; pending CI → Waiting with its GitHub job URL; failed or overdue CI → Idle. Other cases exercise report and merge-hold source messages, subscriptions/schedules, startup recovery, and cross-instance alert deduplication.

`apps/mobile/sources/buzz/corner-states.browser.test.ts` builds the real `StateCircle`, `CornerHeaderAgentText`, and `cornerDisplayState` components with device-only APIs shimmed, then renders them in Chromium. The screenshots show Working, Review, Waiting and Idle in Bone and Obsidian. The same browser proof clicks plain Waiting links for CI, a blocked report and a merge hold and checks their destinations. `corner-server-push.test.ts` connects the server projection to the real header and transcript jump controller.

- [Bone](bone.png)
- [Obsidian](obsidian.png)

These are local component browser screenshots, not production screenshots. The requested signed-in proof at web.usebeeline.app remains pending: Squire finds the reviewer bypass credential but browser-fill rejects the stored link type (`unsupported_credential_type`). Passing its vault reference directly to browser navigation also fails. A live browser share was posted for reviewer sign-in handback. No production deployment was performed.

Run from `apps/mobile`:

```sh
npx vitest run sources/buzz/corner-states.browser.test.ts --maxWorkers=1 --minWorkers=1
```
