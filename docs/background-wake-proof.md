# Background wake isolation

Reproduction `R-BACKGROUND-WASTE` covers the owner’s repeated check events and full turn-table rereads. Production is read-only evidence; the before/after proof runs the affected service against isolated loopback PostgreSQL. No production change or release is part of this proof.

## Reproduced and demonstrated

Run after building the server:

```sh
BEELINE_BACKGROUND_BASELINE_REF=c76fb5b37 \
BEELINE_BACKGROUND_TEST_POSTGRES_URL=postgresql://localhost:56539/postgres \
node scripts/prove-background-waste.mjs
```

The database must be disposable loopback PostgreSQL with pgvector available. The script creates and drops its own schema. The historical revision supplies the original callback; the current `index.ts` supplies the changed registration and callbacks. Jobs are replaced at their provider/database boundaries for the notification replay. The Room-list proof calls the built `PhoneService.readChats`, including its enrichment, against real PostgreSQL.

Measured locally on 2026-10-24:

| Measurement | Before | After |
| --- | ---: | ---: |
| Leader iterations in a minute with one owed notification each second | 60 | 60 |
| Reviewer repair, check-refresh retry, branch cleanup runs in that minute | 60 each | 1 each |
| Voice recovery and operator DM recovery runs | 60 each | 1 each |
| Schedule and Sentry runs / their next-due queries | 60 each | 1 each |
| Push next-due queries | 60 | 1 |
| Deadline runs for the owed notifications | 60 | 60 |
| Room-list reads in each ten-second load | 110 | 110 |
| `agent_turns` sequential scans during that load | 110 (10.999/s) | 0 (0/s) |

The service fixture has 25,717 turns, 142 identities, and 1,596 Rooms. Before: `EXPLAIN ANALYZE` shows one executed sequential turn scan per Room-list read. After: the turn lookup uses the Room index through a bitmap scan. The service also returns `agentState: working` when an open child corner has a working turn, then removes it when that child is archived. These assertions prove the visible state as well as its query plan.

Real notifications still require leader iterations. The reduction is in unrelated jobs and database queries, not in suppressing requested work. `BackgroundWork` logs a minute window with total iterations, wake requests by source, and executions by job. A message requests both tray deadlines and choice expiry, so its two job requests count separately under that source. Timer-only iterations have no notification source.

## Query attribution

Production `EXPLAIN (FORMAT JSON)` was read through the vaulted Neon HTTPS SQL connection. `pg_stat_statements` is not installed; no extension or index was installed in production. Plans identify the following paths, rather than attributing all scans to one loop:

| Source / predicate | Observed plan |
| --- | --- |
| Full current push candidate SQL, captured from `PushDeliveryLoop` | Both turn predicates use `agent_turns_pkey`; claim predicates use `push_delivery_claims_pkey`. |
| `daemon-service.ts` / `agent-command.ts` command-bound turn existence | `agent_turns_pkey` on Room, request, agent. |
| `chat-corner-counts.ts` Room-or-child working predicate | **Sequential scan of all turns**, repeated for each outer Room. The rewrite bounds each lateral lookup by Room and uses the existing index. |
| `connection-presence.ts` request-or-recent-turn predicate | `agent_turns_pkey` with Room and agent conditions. |
| `agent-health.ts` latest real turn | `agent_turns_agent_activity`. |
| `github-star-prompt.ts` latest Room turn | `agent_turns_room_created`. |

The actual push candidate plan scans the small identities table in several projections and hashed membership/tag lookups. The claim point lookups are indexed. Removing unrelated repair / due-query executions addresses their loop amplification; there is no evidence justifying forcing index scans of the small identity table or adding a claim index. No new turn index is needed, so no concurrent index migration is introduced.

A separate live sample from 01:02:37.718 to 01:03:59.387 UTC observed 234 turn scans (2.87/s), 20,431 identity scans (250.17/s), and 126 claim scans (1.54/s). This is an unfixed production baseline at that time, distinct from Ruby’s earlier approximately eleven-turn-scans/s sample and from the controlled before/after load. Deployment measurements remain future evidence; the local result is not a claim of production improvement.

## Wake dependency audit

Each row lists all jobs formerly reached on a generic wake. Repairs have an independent deadline, so a notification cannot bring the minute repair set forward. Due times are cached per job; unrelated notifications do not reread the other jobs’ due times.

| Work | Wake or clock that needs it now |
| --- | --- |
| Push delivery and push next-due read | Push notification; cached outbox due time; minute fallback. |
| Schedule execution and schedule next-due read | Schedule notification; cached next-run time; minute fallback. Existing schedule limits are unchanged. |
| Sentry batching and next-due read | Sentry notification; cached batch due time; minute fallback. The listener now distinguishes Sentry from owed notifications. |
| Tray / owed deadline expiry and next-deadline calculation | Message or owed notification; cached deadline; minute fallback. Leadership takeover retains its replay window. |
| Choice expiry and next-close read | Message notification; cached close time respecting the existing five-second sweep throttle; minute fallback. |
| Free-agent sweep | Existing free-agent sweep interval. Direct committed command wakes still kick a sleeping Machine immediately. |
| Voice recovery; operator System DM queue drain | Minute recovery. Neither has a dedicated notification in the former generic callback; incidental push/owed traffic is not their timer. |
| Promoted-corner branch repair | Leadership startup; failed startup repair retries on minute cadence. |
| Reviewer repair; queued GitHub check refresh; branch deletion retry | Minute repair. GitHub webhook processing remains immediate and unchanged. |
| Mergeability and open-pending-check startup reconciliation | Leadership startup; failures retry on minute cadence. Successful startup reconciliation stays once per tenure. |
| Unfinished merge-claim recovery; merged-corner reconciliation | Minute repair. |
| Media expiry; maintenance; blocked-check notices; expired command leases; mention notices; institutional curator | Minute repair, as before. |

Push, Sentry, schedules, choices, and deadline jobs run before the repair set when both are due. A notification arriving during a running job remains pending for the next iteration. Leadership takeover re-arms all jobs; dedicated advisory-lock ownership is unchanged.

## Webhook burst and phone pool contention

Ruby supplied another production window (2026-10-24, 01:18:47–01:19:13 UTC): about fifteen GitHub webhook POSTs in a second, followed by roughly forty slow-query lines in a second on the server machines. Only two queries were active at the subsequent database sample. This suggests queued work rather than simultaneous SQL execution, but the later activity sample alone cannot prove the earlier queue. Fly machine metadata identifies the deployed image as `0.1.105-62a269572454` on both machines.

The four fingerprints are mapped to their exact parameter-free SQL in [background-query-fingerprints.json](background-query-fingerprints.json). Their hashes were recomputed with the production profiler algorithm, including `CornerAccessStatement` membership rewriting where applicable:

| Fingerprint | SQL / call site | Why it runs during the burst |
| --- | --- | --- |
| `d9831d171473d1fb` | `DaemonService.access`: `SELECT EXISTS(...) corner_reviewer, ... FROM effective_memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL` | Helper inbox/command delivery performs its access check. |
| `42b9a50d4e902175` | `readAgentCommands`: `WITH recovery_scope AS MATERIALIZED (...) ... SELECT c.* ...` | `getAgentCommands` and `getRoomInbox`/`commandInbox` render durable pending commands after live invalidations. Includes workflow expiry/recovery fences. |
| `f08cb3ec410a21df` | `CommanderWakeDeadlines.refresh` (now `refreshOnce`): `SELECT min(command.wake_after) due FROM agent_commands command ... WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='pending'` | Every command invalidation formerly started another deadline read, including while an identical read was waiting. |
| `ca61a04a12b9b235` | `GitHubOperations.processCornerEvent`: `SELECT corner.id corner_id,parent.id parent_id,... FROM rooms corner ...` | Each webhook locates its repository/branch’s corners before reconciling the live rollup. |

The initial PR’s repair-cadence fix does **not** bound these foreground webhook operations. The extension serializes webhook deliveries in arrival order per `GitHubOperations` instance. Every delivery still executes and awaits its own result; there is no event dropping, cached verdict, or skipped subscription. Commander deadline reads separately admit one at a time, coalesce repeated Room/agent requests, and reread after a change received while running. This bounds pool checkouts before they compete with navigation. It does not change reviewer repair behavior or authority checks.

### Reproduction R-WEBHOOK-BURST

Production writes remain forbidden, and the extension has not been deployed. The safe stand-in sends signed POSTs to the built server’s real GitHub webhook route, with a real helper WebSocket subscribed to the affected corner, the PostgreSQL live listener, real `GitHubOperations` reconciliation and `DaemonService` command reads, and concurrent built `PhoneService.readNeedsYou` navigation reads. GitHub responses and helper/phone authentication are fixture boundaries; all database queries use isolated loopback PostgreSQL.

```sh
npm run build -w @beeline/server
BEELINE_BACKGROUND_TEST_POSTGRES_URL=postgresql://localhost:56539/postgres \
node scripts/prove-webhook-burst.mjs
```

The script compiles the original PR’s webhook/commander classes from `7f44162ed` into ignored build output for the negative control. Override `BEELINE_WEBHOOK_BASELINE_REF` if necessary. Both phases use the same five-slot foreground pool, fifteen deliveries over 700 ms and five Needs-you reads. A test-only 80 ms delay per checked-out query models network/statement round-trip occupancy without creating busy SQL; it is not a measured production network latency. Queries are timed by the real `PostgresDatabase` profiler, whose slow threshold is 500 ms. Pool checkout p95 is sampled around the real `pg.Pool.connect`; query delay is excluded from that checkout measurement. Rate is normalized from the observed burst-and-drain window, not extrapolated from a production counter.

Measured on 2026-10-24:

| Burst measurement | Initial PR / before extension | After extension |
| --- | ---: | ---: |
| Signed webhook deliveries acknowledged and stored | 15 | 15 |
| Burst-and-drain window | 9.054 s | 17.164 s |
| Slow-query count (at least 500 ms, including pool wait) | 65 | 0 |
| Slow queries per minute, normalized | 430.73 | 0 |
| Pool-checkout wait p95 | 1,321.90 ms | 0.04 ms |

No query crossed the 500 ms slow threshold in this controlled after run. Serial delivery increased the burst drain time; it preserves ordering while keeping foreground pool checkouts available. Checkout count increased (143 to 217): the helper could complete more of its queued live deliveries instead of remaining stalled. The extension bounds contention, not the number of durable events that must be processed. The recorded access/command-read and webhook-match fingerprints all execute in this proof; the separate commander notification regression verifies that fifteen same-key notifications produce one active read and one follow-up read. Existing wake-digest and webhook tests retain authority, retry, and delivery coverage. Actual phone Back animation and production after-deployment measurements are not claimed by this server-boundary stand-in.


### Delivery ordering regression

The reviewed concurrent admission could finish a later installation deletion before an earlier suspended-installation write. `github-webhook-order.test.ts` reproduced this with unequal database-write durations: `revoked → repositories inactive → suspended`, leaving the installation suspended. A same-duration queue test did not cover that race.

The webhook queue now explicitly admits one delivery at a time. The regression passes with `suspended → revoked → repositories inactive`, leaving the installation revoked. `scripts/prove-webhook-burst.mjs` repeats this path through both built classes and asserts the before/after final state, alongside the fresh burst measurements above. This is serialization within each operations instance; no concurrent queue completion is described as arrival-order preservation.

The same delayed suspension was also reproduced through two independent operations instances against real PostgreSQL: a local queue alone cannot order work on different machines. The suspension UPDATE now requires `status<>'revoked'`, so it cannot overwrite a deletion that another instance already committed. The built proof and the separate real-query regression both retain revoked installation status and inactive repositories after that interleaving.

### Integration with current main

The conflict resolution retains main’s newer reviewer recovery rules and passive-watch behavior alongside minute-cadence repair. The merge-recovery regression now locates the registered repair callback. Main also changes command recovery SQL, so the burst proof records the current command-read fingerprint and verifies that the recovery CTE executes in both phases; the production fingerprint mapping above remains historical evidence.

The repeated Room-list proof still produces 110 full scans before and zero after, while preserving Working and archived-corner behavior.

On the integrated head, the repeated burst proof acknowledged and stored all fifteen deliveries per phase. Slow queries per minute fell from 429.78 to 0.00, and pool-checkout p95 fell from 1596.41 ms to 0.08 ms under the same synthetic occupancy. The current command-read fingerprint is `855547fbb0ffa86c`. Both installation-ordering regressions pass.
