# Corner membership and sparse state

A corner has no roster. `memberships` stores only Workspace, top-level Room and DM memberships. The read-only `effective_memberships` view projects each corner's current parent Room members, so removing a Room member immediately removes corner read, post, mention, command, subscription and wake access. A preference row cannot grant access.

`corner_person_state(corner_id,identity_id)` stores explicit event subscriptions, identity profile, generation and saved push state only when needed. Without a row, subscriptions inherit the parent's subscribable Room event kinds, profile is absent and generation is one. Archived corners expose no event subscriptions. Explicit empty subscriptions remain an override. Existing `room_read_marks` already keys cursors by `(room_id,identity_id)`; `corner_owed` already holds sparse per-message/person owed items, and `corner_attention`, `corner_follows`, schedules, watches and `agent_subscriptions` already have independent sparse keys. None needs a roster row or a destructive state move.

## Migration

`migrateCornerPersonState` runs through the reviewed release migration, not a manual production edit. Schema version 30 requires the view and state table. Database triggers reject corner membership insertion and converting a Room with a roster into a corner. The write guard is installed before draining rows, closing the concurrent-insert gap.

Each transaction locks at most 250 legacy membership rows, copies non-default state and deletes the same rows. Each batch commits independently. A retry resumes the remaining rows, and existing explicit state wins on conflict. Non-subscribable legacy kinds are discarded. Default rows produce no state row. Legacy joined timestamps are retained for migrated state. Corner-row deletion neither recomputes owed items nor emits a false membership-removal event. Owed items and read cursors survive unchanged.

Room membership changes refresh child owed candidates in one set operation instead of invoking a refresh per corner. This short OLTP trigger disables JIT locally: PostgreSQL otherwise crossed its compilation threshold at 1,000 inherited audiences, adding seconds of LLVM compilation.

### Rollout decision required before landing

The current release policy runs migrations before replacing either server Machine, then observes the canary for five minutes. The preceding image reads physical corner memberships. Draining those rows before that image retires would break corner authorization and legacy corner writers during the canary window; rolling back to it would also be unsafe.

This implementation must not enter the routine release unchanged. The commander needs to authorize a compatible predecessor release: derived readers and state writers that tolerate both schemas, with temporary legacy-copy writes conditional on a database transition marker. Once both Machines run that compatible image, this contract migration can drain the rows online and the final image can remove those transitional writers. This changes the brief's next-release timing and needs an authorized brief revision. No production migration or release was dispatched from this corner.

Production data must only change through this reviewed migration. This corner does not dispatch a release. After the next batched release, Ruby owns the Play Review join to Tubing Crew in the squire recorder Chrome.

## Reproduction invite-join-corner-rows

The pre-change stand-in redeemed a Workspace invite with 100,000 unrelated messages and 240 historical corners: 1,392 ms and 240 new corner membership rows.

The regression calls `PhoneService.execute('redeemInvite')` with 333,000 unrelated messages, first 10 then 1,000 historical corners. It checks successful entry, inherited corner readability, zero corner membership rows, zero lazy state rows, repeat-join behavior, equal query counts and bounded timing growth.

On isolated PostgreSQL 16, the latest passing run took 1,982 ms at 10 corners and 169 ms at 1,000 corners, with exactly 16 application queries at both sizes across 11 public Rooms. Earlier warm runs took 88 ms and 50 ms. The embedded runner also passed (136 ms and 120 ms, respectively). Timing includes fixture cold-start and local contention; the regression asserts equal query counts and bounded growth. These are synthetic production-sized fixtures, not a copy of private production transcripts.

The isolated migration fixture seeded 333,000 messages, 1,033 corners and 51,650 legacy membership rows. The migration took 2,556 ms and retained only 1,033 non-default state rows. A second run took 7 ms and moved zero rows. The separate preservation regression verifies owed items, read marks, subscriptions, parent departure/rejoin, mention resolution and database rejection of new corner roster rows.

Run the PostgreSQL proofs only with a disposable loopback database containing the vector extension in `public`:

```sh
BEELINE_INVITE_TEST_POSTGRES_URL='<isolated loopback PostgreSQL URL>' npm test -w @beeline/server -- src/invite-join-deadline.test.ts src/corner-person-state.production.test.ts --maxWorkers=1 --minWorkers=1
```

## Reader audit

All corner-capable `memberships` reads were reviewed. Ordinary reads use `effective_memberships`. Queries that lock a membership row keep the physical table and join through `COALESCE(surface.parent_id,surface.id)` (or the corner's known parent), so revocation serializes with dispatch and decisions. Workspace-only, DM-only and top-level lifecycle paths keep physical memberships. The relay/indexer package has a separate Nostr membership model and does not query this server table.

The inventory below records every changed query location, including authorization embedded in writer statements. Direct state writes moved to `setRoomEventSubscriptions`, corner archival cleanup and reviewer configuration. Removed writers were Room joins, Room creation/member projection, both corner-creation paths, reviewer repair/reconciliation, the Play Review proof fixture and the old inherited-membership backfill. `ensureAgentMembership` checks inherited access for a corner instead of inserting a row.

- `agent-class-retirement.ts`: lines 92.
- `agent-command.ts`: lines 356, 397, 548, 550, 852, 1913.
- `agent-health.ts`: lines 64, 145, 174.
- `agent-schedules.ts`: lines 117, 119, 140, 143.
- `agent-sign-in.ts`: lines 384.
- `agent-subscriptions.ts`: lines 115, 173, 183, 200, 245, 293, 309, 345, 348, 377, 382, 440, 444.
- `agent-voice.ts`: lines 31, 34, 72, 76, 131.
- `background.ts`: lines 326, 433, 476, 524, 531, 542, 573, 576.
- `chat-corner-counts.ts`: lines 75, 103, 110.
- `commander-wakes.ts`: lines 93, 101.
- `commander.ts`: lines 54, 140, 237.
- `computer-session.ts`: lines 42, 44, 47.
- `connection-presence.ts`: lines 361, 430, 459, 479, 766, 858, 898.
- `corner-attention.ts`: lines 121.
- `corner-brief.ts`: lines 265.
- `corner-follow.ts`: lines 67, 126.
- `corner-holds.ts`: lines 25, 27.
- `corner-lifecycle.ts`: lines 255, 1299, 1308.
- `corner-merge-approval.ts`: lines 50, 52, 109, 115.
- `corner-owed.ts`: lines 188, 203, 425, 442, 531.
- `corner-person-state.ts`: lines 26, 38, 62, 75, 88, 89, 98, 120.
- `daemon-service.ts`: lines 1246, 2313, 2507, 2798, 2811, 2823, 2842, 2865, 3228, 3339, 3384, 3385, 3804, 4587, 4665, 5158, 5202, 5401, 5453, 5499, 5502, 5667, 6125, 6185, 6189, 6461, 7096, 7644, 7835, 7940, 8016, 8023, 8040, 8084.
- `database.ts`: lines 2036, 3603, 3614, 3707.
- `deadline-expiry.ts`: lines 39, 48, 59.
- `feedback.ts`: lines 352, 473.
- `free-agents.ts`: lines 259, 373, 402.
- `github-operations.ts`: lines 710, 712, 1682.
- `institutional-history.ts`: lines 41, 49, 54, 60, 64.
- `membership-join.ts`: lines 66, 99, 143, 268.
- `message-mentions.ts`: lines 120, 161, 216, 251, 259, 295, 308.
- `needs-you.ts`: lines 205, 219, 227, 276, 388.
- `phone-service.ts`: lines 1073, 1078, 1152, 1154, 1203, 1205, 1327, 1331, 1362, 1390, 1391, 1395, 1396, 1414, 1417, 1520, 1527, 1630, 1635, 1644, 1658, 1779, 1785, 1787, 1788, 1818, 1881, 2348, 2373, 2435, 2438, 2485, 2488, 2529, 2533, 2591, 2594, 2713, 2714, 2795, 2796, 2806, 2808, 2817, 3009, 3117, 3215, 3366, 3384, 3387, 3563, 3568, 3571, 3576, 3606, 3640, 3708, 3732, 3963, 4123, 4762, 4764, 4806, 4808, 4899, 4901, 4994, 5132, 5134, 5177, 5181, 5238, 5240, 5329, 5389, 5407, 5569, 5714, 5903, 5922, 5926, 5998, 6000, 6056, 6058, 6127, 6129, 6193, 6251, 6259, 6309, 6315, 6317, 6327, 6332, 6404, 6422, 6424, 6514, 6516, 6589, 6690, 6691, 6704, 6705, 6737, 6769, 6794, 6837, 6924, 6957, 7038, 7058, 7061, 7235, 7296, 7485, 7494, 7506, 7514, 7569, 7582, 7743, 7764, 7814, 8022, 8025, 8032, 8044, 8047, 8053, 8089, 8221, 8509, 8526, 8527, 8546, 8556, 8561, 8596, 8885, 9057, 9078, 9081, 9687, 9698, 9714, 9747, 9760, 9806, 9813, 9823, 9873, 9930, 9945.
- `phone-viewing.ts`: lines 59.
- `postgres-live.ts`: lines 60, 64, 800.
- `provider-webhooks.ts`: lines 40, 50, 222, 227.
- `room-choice.ts`: lines 89, 122, 613, 727.
- `system-line.ts`: lines 346, 520, 555, 559.
- `voice-service.ts`: lines 43, 44, 62, 379.
- `welcome-retirement.ts`: lines 111, 122, 128, 131, 154, 210, 218, 227, 230, 234, 236.
- `workflow-admin.ts`: lines 28, 88.
- `workflow-run-views.ts`: lines 26, 30.
- `workflow-runs.ts`: lines 496, 503, 1782, 1920, 2054, 2103.

## Validation and landing blockers

The invite and production-size migration proofs pass, as do the sparse-state/access proof and all 239 monolith integration cases run in bounded batches. Root typecheck, dead-code analysis and workflow-path lint passed. Additional server regression runs exposed legacy corner-roster fixtures; corrected cases were rerun individually. The broad server run is not a clean full-suite result.

The protected `apps/server/src/system-messages-lock.test.ts` fails because its recursive producer scan includes changed authorization SQL literals. The System message guard and its lock file have not been modified. Its explicit rule is: “Do not delete, disable or modify this guard or its list without lunchboxfortwo's express command.” Landing requires owner authorization for the resulting snapshot update or an authorized guard correction, in addition to the compatible rollout decision above.
