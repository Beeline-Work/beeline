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
