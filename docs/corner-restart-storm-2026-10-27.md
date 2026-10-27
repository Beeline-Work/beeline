# Corner wake storm, 2026-10-27

## Findings

The helper journal on squire puts installation exhaustion **before** the
13:47 EDT helper restart. The first GitHub rate-limit refusal is at
**13:39:11.477 EDT**, with reset **18:07 UTC / 14:07 EDT**. The first
corner-start failure is at **13:47:38.503 EDT**. A restart amplified an
already-running failure loop; it did not originate the quota exhaustion.

Read-only evidence was collected with:

```sh
journalctl --user -u beeline-helper.service \
  --since '2026-10-27 12:29:00' --until '2026-10-27 14:11:00' \
  -o json --no-pager \
  --grep 'ACP error -32602|GitHub rate limit|failed to start corner|corner command failed'
```

Counts are journal message occurrences, not unique executions or API requests:

| Period (EDT) | ACP invalid params | Corner command failures | Rate-limit messages | Corner start failures |
| --- | ---: | ---: | ---: | ---: |
| 12:29–13:47 | 3,304 | 4,401 | 1,138 | 0 |
| 13:47–14:11 | 0 | 823 | 2,390 | 523 |

The start failures name six distinct corner IDs. ACP refusals begin at
12:31:23 EDT and continue through 13:46:53 EDT. They exceed 100 journal
occurrences/minute before the first rate limit. Command failures continue
at roughly 140–150/minute during 13:40–13:46. The filtered unit's last
matching failure is at 14:05:59 EDT; these records do not independently
establish the operator's stop/restart times or subsequent recovery.

The evidence supports repeated automatic wakes/intake attempts after protocol
rejection, with additional restore attempts after restart. It does not support
attributing this to agents deliberately retrying GitHub tools: the helper and
server themselves read GitHub before an agent can run. Exact installation-wide
request totals and the fraction attributable to each endpoint cannot be
recovered from this helper journal. A bounded, read-only production aggregate
query was attempted but unavailable; no production rows were changed.

## Quota path before the fix

`DaemonService.execute` refreshed provider state before its command transaction.
`GitHubOperations.refreshCornerReviewHead` read stored PR identity, called
`roomWorkflowTarget`, and then `GitHubAppClient.readPullRequest`.

| Operation | Automatic provider work |
| --- | --- |
| `getCornerRestoreState` for an open corner with a PR | One repository-scoped token mint (`POST /app/installations/:id/access_tokens`), then one live PR read (`GET /repos/:owner/:repo/pulls/:number`) |
| `getAgentCommands` / `claimAgentCommand` | The same pair for each distinct origin corner among pending/claimed commands with `review_context` |
| `order`, `report`, `postCornerMessage`, ordinary `postRoomMessage` in a corner | The same head-refresh path; a completed worker report instead uses unregistered-PR resolution |
| `getRoomRepositoryState` | Database state; no GitHub read |
| `getRoomGitHubToken` | Existing Room token cache/coalescing; one mint on cache miss |

Thus a PR-backed start had **two provider HTTP requests solely for restore**,
plus a possible credential-cache miss. Each pending review-intake retry could
add another pair per origin; a read followed by a claim added two pairs.
These are HTTP request counts, not a claim that token minting and PR reads are
charged to the same GitHub quota category. PR reads use installation tokens
and therefore share that installation's budget across agents and repositories.

Live checks reads are heavier and remain explicit: `prChecksStatus` resolves
the live PR and head, reads `statusCheckRollup`, and consults paginated workflow,
suite and required-check registration. This investigation found no evidence
that checks reads, rather than automatic head refreshes, initiated this incident.

Three mechanisms amplified the outage:

- ACP invalid params fell through to retryable `hiccup`. Exhaustion did not
  make that reviewer unavailable for subsequent automatically generated wakes.
- `RoomSupervisor.wake()` shortened ordinary backoff whenever discovery woke,
  including discovery caused by another corner's failed startup.
- Pushed corner-command snapshots called startup outside the discovery pass's
  four-worker bound. Successful startup cleared local failure deduplication,
  and further failures could open new request-scoped notices.

## Changed behavior

- Restore returns the committed, webhook-fed corner view without a provider
  read. Review handoff/claim validation and the live merge gate still obtain
  current provider evidence; a cooldown fails those operations closed.
- Token minting coalesces and caches by installation, exact repository scope
  and exact permission grant, with the existing five-minute refresh margin.
- Every App-client request goes through a four-request admission bound.
  Documented reset/retry headers establish a cooldown, shared across tokens
  and repositories in the installation. `github_installations.api_retry_at`
  shares it across server replicas and restarts; queued requests recheck it
  before contacting GitHub. Requests already in flight can still finish.
- Server 502 responses preserve `Retry-After`. Helpers also understand the
  dated diagnostic emitted by older servers during a rolling deployment.
- All helper coordinators share a four-start bound with jitter, including
  pushed starts. A startup reset keeps original commands pending and arms one
  recovery wake. Routine discovery cannot bypass the reset.
- Intake and turn failures respect dated resets. ACP JSON-RPC request/method/
  parameter rejection waits for a real configuration change. Ordinary pushes,
  reconnects and discovery do not clear it; stop/restart commands remain usable.
- Invalid ACP requests classify as `helper-out-of-date`, including legacy
  receipts labeled `hiccup`. Review dispatch waits for a configuration/sign-in
  change, helper version change, or demonstrated recovery. Presence refreshes
  preserve version metadata. Standing protocol/auth failures and dated GitHub
  failures share one notice until a successful turn ends the span, including
  resets longer than ten minutes and newly generated wakes.

## Regression evidence

The new `WAKE-STORM` regressions were run against the original implementations:

| Reproduction | Original result | Required result |
| --- | --- | --- |
| 100 identical token requests | 100 mints | 1 mint |
| 80 pushed corner starts across two coordinators | 80 simultaneous restores | At most 4 |
| 60 intakes, repeated discovery during a reset | 1,320 reads | Initial 60 only until reset |
| Rejected ACP intake, unrelated discovery wakes | 31 attempts | 1 until configuration changes |
| Rejected ACP turn, pushed snapshots/reconnects | 11 attempts | 1 until configuration changes |
| Rate-limited turn, pushed snapshots | Immediate replay | Resume after reset |
| Legacy `hiccup` receipt for ACP -32600/-32601/-32602 | Retryable hiccup | Standing adapter failure |

Provider tests cover queued reads, separate repositories, another server client,
reset expiry and exact token-grant boundaries. Server fixtures exercise the
persisted cooldown, readable restore during an outage, repeated ACP receipts,
one notice per span, and recovery after helper version changes. Existing
live-check/merge, transient checkout recovery and command authority tests are
included in validation. Tests use provider fixtures and isolated databases;
there was no live helper restart, production mutation, or deployment.
