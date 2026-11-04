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

## Group E composition

Group E https://github.com/Beeline-Work/beeline/pull/3411 is integrated at
`93e8f3c08`. The composed head passes **48 checks across seven serial suites**,
including all10 real PostgreSQL phone cases and all3 physical leader-lock cases.
Full root typecheck and the20-rule base-aware architecture check pass.
[Selections and log hashes](group-e-integration-validation.json) retain the exact
scope. Its [proof report](group-e-proof-report.md) preserves the remaining
provider/installed-adapter/workload boundaries; no additional finding closes.

## Main integration after the shared timer fix

Main `10b558dd48e998c3fd2b0e0527fd9525d56418ab` is merged with the
combined candidate. The upstream fake-clock fix preserves native Immediate
cleanup and event-loop progress. Join-host discovery and first-workspace creation
compose with router completion readiness; the member stream retains its bearer
challenge instead of serving the new HTML join page. Two regression cases cover
plain and SSE requests on both the canonical and short host.

[Merge validation](main-integration-validation.json) records **180 passing server
cases across six serial suites**, including the full MCP suite and isolated
PostgreSQL stream/OAuth proofs. All10 CI-sharding/timer regressions, all3 bundle
gates, all8 workspace builds, full root typecheck, the20-rule base-aware
architecture guard, phone/router inventories and138 workflow-path references
pass. No deadlines, byte budgets or scanners changed. Remote CI on the pushed
merge remains required; router activation and whole-finding closure are unchanged.

Main advanced to `98c2a49a4f3df909e8fd3fc32ae39129f6f8367b` during the
preceding validation, so its mobile auth recovery is also integrated before CI.
Root navigation retains both router residency ownership and revoked-session
sign-in recovery. Authorization expiry fences late capability discovery;
handshake rejection invalidates stale access within the connection owner's
existing single replacement allowance. Once spent, another attempt requires a
new recovery event. The transport proof verifies no idle authorization or socket
attempt and successful explicit recovery; it does not grant main's additional
automatic handshake replacement. Negotiated-executor tests await socket creation
instead of assuming a fixed number of promise turns.

[Mobile merge validation](main-mobile-integration-validation.json) records
**239 passing cases across10 serial suites**, full root typecheck and the
unchanged phone/router/base-aware architecture guards. The previous server and
bundle validation remains applicable: this additional delta changes neither.
Capability remains off, and native/cohort closure is unchanged.
