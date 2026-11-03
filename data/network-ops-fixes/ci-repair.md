# Integration CI repair — 2026-11-03

PR: https://github.com/Beeline-Work/beeline/pull/3335

The integration branch was rebased onto main `14abf2995`. Checkpoint
`f9d8473f3` preserves the earlier Group A integration resolutions and repairs
inherited CI failures. Router capability remains off; this report does not
change finding closure or cohort rollout status.

## Failure classification and repairs

- The legacy mobile fixtures had no capability negotiation. They now explicitly
  represent an old server, with router command authority forbidden. All 32
  formerly failing files pass locally: **226 checks**, one suite at a time.
  The Tray error-row evidence selector was updated to its current source JSX;
  screenshot assertions and historical before snapshots remain intact.
- Scheduled Work migration fixtures now model insertion before the owner source
  trigger existed. The frozen legacy Room event matches `postgres-live.ts` at
  `f43bd3f86`; its source-Room body never had an `operation` field. Exact older
  notification/journal comparisons and zero-write negotiation remain enforced:
  **2 authority migration + 15 row-source checks pass**.
- Source-plan, mutable Tray authority, bounded bookmark excerpt, explicit
  deadlock recovery, due-revision failure fencing, and source-owned repair
  dispatch assertions now reflect the router implementation. They retain
  authorization, rollback, size, and no-automatic-retry assertions.
- Optional PostgreSQL phone proofs defer mobile imports until their enabled
  setup, so a server-only CI installation can collect the skipped suite.
- Main's welcome-retirement and handle-backfill migrations use the existing
  single-attempt migration runner. Nightly completion retains main's failure
  classification and issue scope without restoring run polling.
- Two MCP cases that previously exceeded the shared runner budget pass on the
  requested rerun: **6 selected checks** under their unchanged limits.
- Legacy replay exposed two distinct costs: PGlite microtasks starved the
  in-process socket receiver, and an empty Needs-you snapshot still projected
  cells. The fixture now yields at the database I/O boundary. Production skips
  only the redundant cell query when the same read-only snapshot proves zero
  items, still sending the empty delta. **Both F04 checks and all 9 durable
  replay checks pass**, including 300-message reconnects with unchanged limits.

The final local selection passes **349 Vitest checks across 47 serial suite selections**;
[reproducible selections and log hashes](ci-repair-validation.json) record scope.
All **9 expiry** and **10 isolated PostgreSQL** cases also pass. All eight
workspace builds and dead-code checking pass (5 existing findings, 0 introduced).

## Preserved gates

Root typechecking, the phone network inventory, and router boundary inventory
pass locally. Owner bundle measurement remains **86,453 raw / 24,495 gzip**
bytes (limits **90,112 / 24,576**). Shadow measurement remains **28,070 / 5,962**
(limit **32,768 / 8,192**). No budgets, scanners, required checks, or production
capabilities were weakened.

## Base architecture restored

Following instruction 050, the three rules now exactly match `origin/main`:
server environment budget 60, phone parallel-path budget 19, and notification
publishing owned only by `postgres-live.ts`. The unchanged base-aware checker
passes all 20 rules. The rollout flag uses the startup configuration reader;
its disabled default and exact explicit enable value remain unchanged.

Chat-list acquisition, Needs-you count subscriptions, Tray view selection and
media connection installation now select their old-server adapter inside the
existing negotiated owner. Pending or disconnected capable paths never select
legacy HTTP. Explicit negative capability receipts retain old-phone behavior.

Notification publishers moved into the accepted live owner. Wire identities and
synchronous decoders remain in the dependency-light notifications module;
schema construction runs after initialization. The live SQL is byte-identical
to the preceding repair (SHA256
`4a981927f6b0481293c59c6faf13fb0ba31e958976987bd952678e498d4af513`).
Four fresh-process import regressions cover Needs-you, authority, live and
command-completion entry orders. This fixes both native ESM initialization and
the Vite migration setup cycle without changing notification content or delivery.

The additional validation record records **207 passing checks across 14 serial
suite selections** and distinguishes this repair from the earlier 349-case
selection. Root typechecking, all eight builds and dead-code checking also pass. Remote CI completion is still required; local passes are
not a green remote-CI claim.
