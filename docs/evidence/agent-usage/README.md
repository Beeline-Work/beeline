# Phase 1 agent usage proof

This is a feature, not a defect report. Design authority is corner brief revision 2, panels 1–6 and 3b. Screenshots use the production React Native Web profile and Members row; transport data is synthetic. The native Android image uses the production meter and Settings rows in an Expo Go host with the existing Unistyles adapter. It is a native component proof, not a signed-in production app session.

## Provider → server → profile

`apps/body/src/fixtures/claude-rate-limit-event.json` was captured from a successful Claude Haiku SDK turn on squire on 2026-10-18. Only the random event/session identifiers were removed. The installed SDK reports utilization inside `unifiedWindows`; the adapter forwards the entire `rate_limit_info` through `_meta["_claude/rateLimit"]`. Single-window reports remain supported.

Run `npx vitest run apps/server/src/agent-usage.integration.test.ts --maxWorkers=1 --minWorkers=1`. The test feeds this captured report through the daemon parser and authenticated daemon operation into a migrated database, then reads the profile and Members APIs through their client guards. It also checks partial-window merging, rejected reports without utilization, stale report protection, caller ownership, viewer privacy, and the owner-wide free allowance's midnight UTC reset. The feature is absent on main: there is no usage parser, stored snapshot, or daemon usage operation there.

Committed test output: [server-tests.txt](server-tests.txt). The real-turn evidence in [prompt-turn.txt](prompt-turn.txt) sends the production prompt formatter's line, read through an isolated migrated daemon service, to an actual Claude SDK turn on squire and compares its response exactly. The Room turn regression separately asserts delivery through the production turn assembly path. The running helper was not restarted or changed.

## Rendered panels

Start `node apps/mobile/scripts/render-consolidated-board-proof.mjs`, then open `http://127.0.0.1:4179/?view=profile&usage=warning`. States are `normal`, `warning`, `stopped`, `none`, `old`, and `free`. Use `view=usage-members` for the production Members row, and `theme=light` for Bone. Browser assertions and rendered copy for all 24 state/theme/surface combinations are in [chrome-checks.json](chrome-checks.json): zero browser errors, no horizontal overflow at 390px, and no profile meter for a non-owner.

| Approved panel | Rendered evidence (Groknight / Bone) |
| --- | --- |
| 1. PLAN USAGE; 5-hour, Weekly, Weekly Opus; CONTEXT | [Normal](profile-normal-dark.png) / [Normal Bone](profile-normal-light.png) |
| 2. FREE ALLOWANCE; Today; Counted by Beeline · live | [Free](profile-free-dark.png) / [Free Bone](profile-free-light.png) |
| 3. Members highest window plus every window at 80%+ | [Warning row](members-warning-dark.png) / [Warning Bone](members-warning-light.png) |
| 3b. limit reached · back | [Stopped profile](profile-stopped-dark.png), [Stopped row](members-stopped-dark.png) / [Bone profile](profile-stopped-light.png), [Bone row](members-stopped-light.png) |
| 4. Claude Code doesn't report usage to Beeline. No bar or roster suffix | [No report](profile-none-dark.png), [Row](members-none-dark.png) / [Bone](profile-none-light.png), [Bone row](members-none-light.png) |
| 5. Last updated <time> · agent idle since; figures retained | [Old](profile-old-dark.png) / [Old Bone](profile-old-light.png) |

Panel 3 uses the locked rule: the highest utilization window, plus every window at 80% or above. Thus the 83% weekly window is shown and the 42% 5-hour window is omitted in the warning row. Normal rows show the 42% 5-hour window. Percentages below 80% use textSecondary, warnings accent, and only a provider rejection uses dialogDanger. Free allowance exhaustion does not invent a provider rejection.

For native Android, boot an isolated emulator with `beeline emulator`, install Expo Go SDK 55, and run `npx expo start --go --port 8137 --lan` from `apps/mobile/usage-proof`. Open that Metro URL on the guest (or reverse its port). [Native screenshot](android-profile-meter.png) and [accessibility hierarchy](android-profile-meter.xml) show the plan windows, brass warning, source timestamp, and context meter.

No release was dispatched. The brief's production check after release remains with the surviving commander/reviewer.
