# Corner membership: additive step A

New servers derive corner access from current parent Room membership. `memberships` retains legacy corner rows temporarily so the preceding server image can keep reading them during the rollout. New Room joins and corner creation do not add corner rows. A saved preference cannot grant access after parent departure.

`corner_person_state(corner_id,identity_id)` stores explicit subscriptions, identity profile, generation, saved push state and the original joined timestamp. Missing state inherits subscribable parent event kinds, no profile, generation one and no corner mute. Archived corners expose no subscriptions. Existing independently keyed owed items, attention, read marks, follows, watches and schedules stay in place.

## Online compatibility migration

The migration creates the table and derived view, then copies only non-default state in transactions of at most 250 locked legacy rows. It deletes no membership rows and installs no insert-reject trigger. Existing sparse state wins on retry. Temporary synchronization triggers carry old-image preference writes into sparse state and reflect new-image changes into existing legacy rows; they never create a membership row. The old image's schema marker (29) is retained because this expansion is additive.

Step B belongs to a follow-up corner after both Machines run step A: drain legacy rows in batches, add the database write guard and remove compatibility synchronization. This corner dispatches no release and edits no production data.

## Unchanged message templates

The protected lock and test remain unchanged. `CornerAccessDatabase` resolves unqualified membership **read** relations through `effective_memberships` at execution. Stored membership writes remain physical; literals, comments and bound parameters remain untouched. Locking statements resolve the inherited parent key while retaining locks on real rows. `CornerAccessStatement` applies the same read resolution to the reusable mention projection. This keeps the reviewed message call templates and their recorded dependency literals unchanged without renaming the physical database object used by the old image. The adapters are temporary compatibility code for the reviewed SQL statements, not a general SQL parser.

## Reproduction invite-join-corner-rows

Before the fix, the approved service stand-in redeemed a Workspace invite with 100,000 messages and 240 historical corners in 1,392 ms, adding 240 corner membership rows.

The step-A PostgreSQL proof calls `PhoneService.execute('redeemInvite')` with 333,000 messages and 11 public Rooms. At 10 and 1,000 corners it used 16 queries each, wrote zero corner memberships or state rows, and granted inherited corner reads. Latest timings: 3,493 ms and 190 ms. Local contention affects absolute timings; query count and bounded growth are asserted.

The production-sized generated migration fixture retained all 51,650 legacy rows across 1,033 corners and copied 1,033 non-default state rows in 2,967 ms. A safe second run copied zero rows in 2,418 ms. This is synthetic production-sized data, not private production transcripts. The compatibility regression repeats the old image's physical membership access query and verifies preference updates in both directions, parent departure/rejoin, preserved owed/read state and subscribed wakes.

```sh
BEELINE_INVITE_TEST_POSTGRES_URL='<disposable loopback PostgreSQL URL>' npm test -w @beeline/server -- src/invite-join-deadline.test.ts src/corner-person-state.production.test.ts --maxWorkers=1 --minWorkers=1
```

The old image still requires legacy rows for people/corners created during a mixed-version or rollback interval; it cannot understand inherited-only access for a new join. Release operators must account for this known predecessor limitation during canary/rollback. Step B and the Play Review Tubing Crew demonstration remain Ruby's follow-up after step A release.

## Reader audit

All corner-capable `memberships` reads were reviewed. Ordinary reads use `effective_memberships`. Queries that lock a membership row keep the physical table and join through `COALESCE(surface.parent_id,surface.id)` (or the corner's known parent), so revocation serializes with dispatch and decisions. Workspace-only, DM-only and top-level lifecycle paths keep physical memberships. The relay/indexer package has a separate Nostr membership model and does not query this server table.

The inventory below records every changed query location, including authorization embedded in writer statements. Direct state writes moved to `setRoomEventSubscriptions`, corner archival cleanup and reviewer configuration. Removed writers were Room joins, Room creation/member projection, both corner-creation paths, reviewer repair/reconciliation, the Play Review proof fixture and the old inherited-membership backfill. `ensureAgentMembership` checks inherited access for a corner instead of inserting a row.

- `agent-class-retirement.ts`: lines 92.
- `agent-command.ts`: lines 358, 400, 552, 554, 857, 1919.
- `agent-health.ts`: lines 66, 148, 178.
- `agent-schedules.ts`: lines 119, 121, 142, 145.
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
- `corner-lifecycle.ts`: lines 257, 1303, 1312.
- `corner-merge-approval.ts`: lines 50, 52, 109, 115.
- `corner-owed.ts`: lines 188, 203, 425, 442, 531.
- `corner-person-state.ts`: lines 26, 38, 53, 89, 103, 104, 135.
- `daemon-service.ts`: lines 1248, 2315, 2509, 2800, 2813, 2825, 2844, 2867, 3230, 3341, 3386, 3387, 3806, 4589, 4667, 5160, 5204, 5403, 5455, 5501, 5504, 5669, 6127, 6187, 6191, 6463, 7098, 7646, 7837, 7942, 8018, 8025, 8042, 8087.
- `database.ts`: lines 2037, 3604, 3615, 3708.
- `deadline-expiry.ts`: lines 39, 48, 59.
- `feedback.ts`: lines 352, 473.
- `free-agents.ts`: lines 259, 373, 402.
- `github-operations.ts`: lines 710, 712, 1682.
- `institutional-history.ts`: lines 41, 49, 54, 60, 64.
- `membership-join.ts`: lines 66, 99, 143, 268.
- `message-mentions.ts`: lines 122, 164, 219, 254, 262, 298, 311.
- `needs-you.ts`: lines 205, 219, 227, 276, 388.
- `phone-service.ts`: lines 1076, 1081, 1156, 1158, 1207, 1209, 1331, 1335, 1366, 1394, 1395, 1399, 1400, 1418, 1421, 1524, 1531, 1634, 1639, 1648, 1662, 1783, 1789, 1791, 1792, 1822, 1885, 2352, 2377, 2439, 2442, 2489, 2492, 2533, 2537, 2595, 2598, 2717, 2718, 2799, 2800, 2810, 2812, 2821, 3013, 3121, 3219, 3370, 3388, 3391, 3567, 3572, 3575, 3580, 3611, 3645, 3714, 3739, 3970, 4130, 4769, 4771, 4813, 4815, 4906, 4908, 5001, 5139, 5141, 5184, 5188, 5245, 5247, 5336, 5396, 5414, 5576, 5721, 5910, 5929, 5933, 6005, 6007, 6063, 6065, 6134, 6136, 6200, 6258, 6266, 6316, 6322, 6324, 6334, 6339, 6411, 6429, 6431, 6521, 6523, 6596, 6697, 6698, 6711, 6712, 6744, 6776, 6801, 6844, 6931, 6964, 7045, 7065, 7068, 7242, 7303, 7492, 7501, 7513, 7521, 7576, 7589, 7750, 7771, 7821, 8029, 8032, 8039, 8051, 8054, 8060, 8096, 8228, 8516, 8533, 8534, 8553, 8563, 8568, 8603, 8892, 9064, 9085, 9088, 9694, 9705, 9721, 9754, 9767, 9813, 9820, 9830, 9880, 9937, 9952.
- `phone-viewing.ts`: lines 59.
- `postgres-live.ts`: lines 60, 64, 800.
- `provider-webhooks.ts`: lines 40, 50, 222, 227.
- `room-choice.ts`: lines 91, 125, 617, 732.
- `system-line.ts`: lines 349, 524, 559, 563.
- `voice-service.ts`: lines 45, 46, 64, 381.
- `welcome-retirement.ts`: lines 111, 122, 128, 131, 154, 210, 218, 227, 230, 234, 236.
- `workflow-admin.ts`: lines 30, 91.
- `workflow-run-views.ts`: lines 26, 30.
- `workflow-runs.ts`: lines 498, 505, 1785, 1924, 2059, 2109.
