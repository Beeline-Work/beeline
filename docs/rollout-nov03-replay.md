# November rollout replay

Reproduction `rollout-0707` is an isolated replay of the production schema
overlap, not a production deployment. Production was read through Sentry and
the host's archived Fly log collector. No production schema or Machines were
changed by this investigation.

## Recorded failures

| Issue | Recorded event and path |
| --- | --- |
| November 3 column errors | Event `466aa2408b8c47348aac9a16b97f527a`, November 3 07:08:34 UTC, release `3fe0d1b17ef0f73a6e6948b117ba7130e736a209`: `column waiting_fact.owner_agent_id does not exist`. Other events name `fact.owner_agent_id` and `owner_fact.owner_agent_id`. Fly logs in the requested 07:00–07:10 UTC window show corner lists, daemon replay, GitHub and Sentry wakes failing after 07:07:59. |
| SERVER-24 | Event `5bb487e9f3c748f08d428fe653981658`, November 2 21:11:59 UTC, release `75e48e93346e3304e29f3101db55e24bcc74227e`: transaction deadline in `DaemonService.execute`. The matching Fly route is `postAgentTurnReceipt`; the event is not a machine-report call. |
| SERVER-25 | Event `534f2fb1712b472fb6d3210b4b4aac0c`, November 2 21:12:41 UTC: lock timeout inside `createAgentCommand`'s INSERT, called by `flushSentryWakes`. Subsequent Fly errors also show the digest singleton waiting. |
| SERVER-1A / SERVER-26 | Events `4ad2aae26c47425298fcfb3d2a4b5bb8` and `70aec06b59b34e22b735171fcf55e500`, November 2 21:18:20–22 UTC: pool checkout failures in phone session authentication and GitHub corner-event processing. |
| SERVER-27 | Event `db04a711c86948d18b913312503ad871`, November 2 21:21:58 UTC, release `75e48e93346e3304e29f3101db55e24bcc74227e`: `column "reached_milestone" of relation "github_star_prompts" does not exist` while posting a reply. |

The connection consumers appear before the checkout failures: Fly records the
command-output authorization fingerprint `40e5b1d81cb90255` waiting for a
command row for 25.6 seconds at 21:11:53, followed by waits approaching the
transaction deadline. Hashing the released SQL maps that fingerprint to
`SELECT command.* ... FOR UPDATE OF command`. These same-command writer
transactions occupied foreground slots while waiting on one another. The
historical records do not identify the initial lock holder. The 21:06 release's
actual migration step began at 21:33, so the earlier lock/pool failures must not
be attributed to that migration merely from the workflow's start time.

## Fix boundaries

- Retain and repair both incident columns for preceding serving and rollback
  images. Current ownership and milestone reads remain derived. Retained owner
  attribution is anonymised during account deletion.
- Queue the same agent/Room's command reads, claims and output before checking
  out a connection. PostgreSQL still owns cross-machine locks, cancellation and
  generation authority. Queue waits do not spend a transaction deadline or
  occupy the remaining phone/webhook slots. No pool size or write retry changed.
- Reserve Sentry dispatch without waiting on its advisory/singleton locks. If
  the INSERT itself encounters a lock timeout, roll back the entire batch and
  leave its pending issues and wake clock untouched for the existing durable
  loop. Other errors still throw; no partial write is retried here.
- New column contracts belong in `apps/server/contracts/`. The release checks
  the candidate and preceding serving/rollback source revisions before any
  migration, then verifies that every Machine runs the candidate before column
  contracts execute. Contracts also run on a same-image rerun, so an interrupted
  contract phase is not mistaken for completion. An unidentified image fails
  closed. Existing unrelated drops are frozen in the baseline; the two incident
  columns cannot be grandfathered by the previous-drop exemption.

The source guard is conservative about ambiguous unqualified columns and
wildcard reads. Computed output aliases and another table's qualified columns
do not by themselves block a legitimate contract. Contract files accept only
idempotent individual column drops; this does not redesign other migrations.

## Reproduce and demonstrate

Build workspace dependencies and the server, then run:

```sh
node --import tsx scripts/prove-rollout-overlap.mjs --baseline
node --import tsx scripts/prove-rollout-overlap.mjs
```

The script compiles the exact recorded server and shared-package sources from
the two pinned Git commits into isolated proof output. It uses real bearer
authentication and built HTTP routes against throwaway PostgreSQL-compatible
PGlite databases. The baseline reconstructs the destructive incident schema:
the released corner-list and command-fetch routes fail, and the released
posting build cannot commit its milestone upsert. It counts three missing-column
errors. With compatibility repaired, the same routes succeed, the phone HTTP
read contains the posted reply, and the count is zero. The reverse direction
starts with the actual preceding schema and data, applies the candidate's
predeployment expansion, and serves it with the candidate build.

The November 2 posting replay uses that rollout's schema, before November 3's
unrelated reviewer-column removals. It does not claim that every historical
image remains a supported rollback for today's complete schema. These are
bounded path replays, not a replay of every request in the production burst.

`rollout-overlap.test.ts` freezes the exact released ownership expressions and
reply SQL. Both tests fail on unchanged main with the recorded missing-column
errors and pass after repair, including repeated migrations and installations
where the columns were already dropped.

`incident-deadlocks.test.ts` uses real isolated PostgreSQL. A held command row
and concurrent receipt/activity requests reproduce slot exhaustion on unchanged
main; after the fix, phone authentication and the GitHub webhook succeed while
only one writer waits, then every receipt/activity request completes without a
transaction deadline. A separate receipt test holds each writer briefly after
its real row lock: unchanged main exhausts later writers' transaction deadlines,
while queued writers each finish within their own deadline. Sentry tests hold the dispatch lock, singleton row and an
INSERT-trigger lock in turn: the batch stays pending, then delivers once after
release. The unchanged-main contention regressions fail. The initiating
production lock holder is unavailable, so these are deterministic stand-ins for
the recorded lock and pool conditions, not a claim to have identified that holder.

Run the PostgreSQL cases with `BEELINE_INCIDENT_TEST_POSTGRES_URL` pointing at an
isolated loopback database. CI already supplies that variable. No new test is
skipped when that configured suite runs. The proof requires the two pinned Git
commits locally; it does not fetch history or contact production itself.
