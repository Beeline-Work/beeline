# GitHub call budgets

GitHub documents a server-processing cutoff of (10 seconds) for REST requests:
[GitHub REST troubleshooting](https://docs.github.com/rest/using-the-rest-api/troubleshooting-the-rest-api#timeouts).
`githubFetch` allows (15 seconds), including transport, and composes any earlier
caller signal. Storage and other providers retain the shared (20 second) limit.

These counts include cold token mints, the existing retries and the immediate
queue/recovery reads. They do not assume a warm token or add production timing logs.

| Path | Maximum sequential GitHub requests | Source | Non-request waits | Client bound |
| --- | --- | --- | --- | --- |
| Create personal repository, including proactive user-token rotation | 2: OAuth refresh + repository POST | `apps/server/src/github-operations.ts:664`, `:2871`, `:2945`; `apps/auth/src/github.ts:251`, `:1267` | Local persistence | 60s, above 2 × 15s |
| Create organization repository, including proactive user-token rotation | 3: OAuth refresh + installation mint + repository POST | Same server creation/credential paths; `apps/auth/src/github.ts:444`, `:1275`, `:1283` | Local persistence | 60s, above 3 × 15s |
| Approve and merge without a queue | 12: gate 6 + merge 4 + confirmation 2 | `apps/server/src/github-operations.ts:1038`, `:1082`, `:1128`, `:1195`; `apps/auth/src/github.ts:1015` | Gate retry backoff ≤90s | Shared merge bound 540s (12 × 15s + 90s < 540s) |
| Approve and enqueue, including immediate reconciliation after the queue becomes invalid | 19: gate 6 + enqueue 5 + reconciliation 8 | `apps/server/src/github-operations.ts:1090`, `:1141`, `:1631`; `apps/auth/src/github.ts:1031`, `:1037`, `:1041` | Two retry-read backoffs ≤180s total | 540s (19 × 15s + 180s < 540s) |
| Lost enqueue response, recovery finds an entry, immediate reconciliation | 22: gate 6 + enqueue 5 + outcome recovery 3 + reconciliation 8 | `apps/server/src/github-operations.ts:1145`, `:1154`, `:1157`, `:1159`, `:1165`, `:1631` | Two retry-read backoffs ≤180s total | 540s = 22 × 15s + 180s + 30s for local work |
| Existing repository-card action | Creation stage ≤3, as above; its existing catalog refresh also enumerates installations/repository pages | `apps/server/src/phone-service.ts:7619`, `:7623`; `apps/mobile/sources/sync/transport/monolith-operation.ts` | Existing refresh work | Existing 60s retained; exceeds the creation-stage bound |
| Existing Workspace deletion | No GitHub creation/merge sequence | `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx:423` | Server transaction deadline 30s | Existing caller limit 40s retained |

The gate's six calls are one installation mint (`github-operations.ts:779`),
one PR read (`:882`) and up to four check-rollup attempts (`:883`;
`apps/auth/src/github.ts:795`, `:77–84`). `landCornerOutcome` uses
`prChecksStatus` without its optional zero-check-confirmation branch.

Direct merge is installation mint, PR read, queue-configuration query and REST
merge (`apps/auth/src/github.ts:1022–1062`). The enqueue branch instead reads the
queue entry and enqueues when absent, making five calls. The direct success path
then mints a confirmation token and reads the merged PR (`github-operations.ts:1195–1199`).

Outcome recovery is mint + PR read + queue read (`github-operations.ts:1154–1159`).
Reconciliation is mint + PR read + queue read, optionally dequeue, then up to four
rollup attempts if a combined head exists (`:1649–1670`). A rollup may retry three
times; each backoff is capped at (30 seconds), for at most (90 seconds) per rollup.
The merge client budget includes both gate and reconciliation backoffs.

Ordinary Close corner, Message, Delete/Leave Room, Stop, choice and lock actions
retain the default (20 seconds). They do not inherit the merge allowance.
