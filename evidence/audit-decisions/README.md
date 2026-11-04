# Accepted audit decisions

This batch implements the captain's accepted recommendations. L1 is the only
committed production change, made after
https://github.com/Beeline-Work/beeline/pull/3447 existed. The four schedule rows
remain stored; `l1-stop-and-readback.json` records the independent read-back.
B1's first attempt was cancelled and fully rolled back after lock contention.
The corrected monitored apply is held until 2026-11-04 08:00Z; see the execution
plan and rollback evidence below. Dry-run counts are in `b1-dry-run.json` and
`b1-before-apply.json`.

| Decision | Implementation |
| --- | --- |
| G1 | `scripts/check-architecture.mjs` reports relaxations for weekly review; candidate rules still must pass. `scripts/ci-workspace-tasks.sh` runs the candidate guard. |
| G2 | System catalog shape and source-use guards remain; phrase changes are reviewed weekly without a wording hash approval gate. |
| G3 | The old System fingerprint lock was already removed. The wording-hash approval gate and corner declaration lock are retired; the catalog guard and exhaustive corner reference replace them. |
| B1 | `scripts/audit-decisions-cleanup.mjs` defaults to `BEGIN READ ONLY`, counts exact D1 classes, and rolls back. `--apply` changes the skill-version job FK to `ON DELETE SET NULL` before deleting jobs, and checks that every skill version survived. Never called by deployment. No successful production apply; corrected execution held until 08:00Z. |
| B2 | Maintenance keeps the latest 200 tool/output activity rows per archived corner, matching `ROOM_VIEW_TOOL_ROW_LIMIT`; leaves open corners, prose and durable facts alone. Scans at most 20 archived corners and deletes at most 1,000 rows per pass; an ephemeral cursor rotates completed slices. |
| B3 | Check-start and individual check-pass notes stop. Whole-head green, failure, conflict and merge notes remain; note IDs retain their dedupe formulas. |
| B4 | Expired claims become terminal `uncertain` after a crashed send, or `failed` for exhausted retries. Active outbox windows survive. Uncertain rows retain an hour before deletion. Expired join devices and notifications are swept in bounded batches after the existing one-hour delivery window. |
| B8 | Redundant corner-note card source/dedupe writes stop. Completed agent-class migration and readers of custom_tags/weight_tier_rules are retired. `scripts/audit-decisions-drop-columns.sql` stages the three drops after every serving and supported rollback image is free of those readers. Compatibility columns stay in schema until that reviewed one-time contract runs; no unsafe rolling drop ships. |
| L1 | `scripts/audit-decisions-schedules.mjs` stops exactly the four accepted schedules without deletion. Exhausted max_runs also prevents future firing in the scheduler. A finite year-9999 next-run time parks the rows safely on older deployed code, which otherwise fires once and deletes them. |
| L3 | Feedback triage instructions open eligible routine fixes without per-item pre-approval. Reviewer PASS plus green checks lands them; the owner keeps a hold as veto. Existing eligibility, product and destructive-action authority remain. |
| E1 | External tools accept explicit commandId, retain that order's human requester and generation, renew its lease per call, and finish on report. A fabricated, wrong-address, wrong-member or live non-MCP claim is refused; expired generations are replaced. Ambiguous legacy report fallback lists orders instead of picking one. |

B5 leaves 30-day webhook replay protection unchanged. B6 lets the correction-repeat
metric age out. B7 keeps writing `rooms_mcp_audit` and `agent_turn_traces`; the B1
script now excludes both telemetry tables entirely. L2 leaves stale feedback
items alone. E2 leaves the unused OAuth client to existing 30-day maintenance.
L4 signing-key and E3 session-token rotation are outside this batch.

## Operator commands

`node scripts/audit-decisions-prod-read.mjs` runs only B1 aggregate counts on the
existing server machine; it does not upload files or expose credentials.
`node scripts/audit-decisions-schedules.mjs` reads only the four schedule summaries.
After the PR is up, `node scripts/audit-decisions-schedules.mjs --stop` performs
L1, followed by the read-only command for independent read-back.

Firstmate relayed the captain's explicit B1 authorization, excluding both telemetry
tables, then held the corrected apply until 08:00Z. Follow the low-traffic plan
below, including a fresh restore point and dry run. Run
`scripts/audit-decisions-cleanup.mjs --apply` with the existing database environment,
never a URL in argv. B8 column drops must wait until the
serving and supported rollback images have drained their old readers, per
`docs/release-pipeline.md`; the SQL file is not wired into release migrations.

## Validation

Root typecheck (workspaces, mobile and scripts), workspace build, dead-code
baseline, architecture checks (also against base), rollout schema compatibility,
workflow paths, shellcheck and CI-selector tests passed.

Targeted regressions passed: GitHub operations (137), System catalog (549),
scheduler (22), MCP (155), cleanup (8), pure corner state (39), exhaustive corner
reference (1 with 1,344 combinations), corner-person-state projection (1), joined
session (11), and external rules (4). Push-outbox tests passed (10 passed; the
isolated PostgreSQL performance proof was skipped without its opt-in local URL).
The one-time cleanup's PGlite proof passed and retained every skill version.
No lifecycle command, release, B1 apply or B8 contract was run.

## L1 production read-back

All four rows remain stored. `max_runs` now equals `run_count`:
0487e469 = 14, e61b92db = 2, ea5594a0 = 7, fc1f2142 = 5.
Every `next_run_at` is 9999-12-31 00:00:00+00, and no workflow is running on
these rows. An independent READ ONLY transaction matched the update receipt.
B1 deletion and the B8 column contract were not run.

## B1 execution authorization update

Firstmate inbox 002 relayed the captain's explicit yes to apply B1, EXCLUDING
`rooms_mcp_audit` and `agent_turn_traces`. The script now omits both from its
deletion list and records their before/after counts in one consistent snapshot;
normal concurrent telemetry writes may appear on a later independent read.
A Neon branch of beeline-prod is required as the restore point before applying.
The initial `b1-dry-run.json` is historical: its two telemetry counts are retained
classes, not approved deletions. All other listed D1 predicates remain approved.

## B1 lock-boundary correction

The first attempt was cancelled and fully rolled back after 51 clients were
observed blocked. The FK was still CASCADE afterwards, all deletion classes
were restored, and all 228 versions/18 links remained. No client remained blocked
by that cancelled backend. `b1-lock-rollback.json` records this evidence.

Root cause: the outer transaction held both the FK DDL lock and journal stream
row locks through every card batch (`durable-live.ts` upserts the stream row on
each notification). Statement limits do not release transaction locks. The
corrected script commits the short FK change first, autocommits ledger batches
and 25-row keyset card batches, and yields between card batches. A regression
test fails on the preceding script and passes with 1,002 card rows on this one.
Telemetry comparisons use a fixed created_at cohort, so concurrent new audit
rows do not obscure preservation of the rows present before cleanup.

## B1 low-traffic execution plan (firstmate inbox 003)

No further apply before **2026-11-04 08:00:00 UTC**. At or after that window:

1. Create a fresh ready Neon branch from beeline-prod/main and record its name/LSN.
2. Rerun the dry run and compare the approved classes, all skill versions and
   retained telemetry cohorts with the recorded counts; allow ordinary growth.
3. Use the CLI's monitored apply: `lock_timeout=2s`, a 5s FK statement deadline
   and a 60s deadline for each data statement. Commit the FK switch alone. Its
   immediate pg_stat_activity/pg_locks read-back must show no blocked clients
   or waiting locks.
4. Delete dead ledgers in autocommitted batches of at most 1,000; strip the
   fixed card cohort in 25-row keyset batches. Pause 25ms between batches.
   A second connection monitors this cleanup backend every 100ms and before
   each write, cancelling on the first observed blocked client or waiting lock.
   Any error stops the runner; do not blindly repeat partially committed work.
5. Read back all deletion classes, the approved value/card cohort, all 228
   original skill versions, and both retained telemetry cohorts. New telemetry
   rows may grow the live total; pre-cleanup cohort counts must stay equal.
6. Commit before/after evidence and the fresh snapshot name, update the PR body,
   and wait for CI green. B8 column drops remain outside this apply.

The monitor regression proves a blocking observation refuses any write.
The transaction regression proves the hot card updates run outside the FK
transaction and reaches zero keys across more than 1,000 fixture rows.

## CI regression corrections (firstmate inbox 004)

All three reported failures reproduced locally before the corrections:

- HEADER-STATE-6 looked for the retired card.dedupe metadata. It now asserts
  the unchanged deterministic merge-note id, absent redundant card, merged event
  and one identical receipt after reconciliation. Locked-corner/close assertions
  remain unchanged.
- The readable L3 procedure had changed while FEEDBACK_TRIAGE_STEPS still
  carried the old pre-approval instruction. The runtime seed now matches the
  readable copy. Saved-procedure coverage checks routine dispatch without
  per-item pre-approval, reviewer PASS plus green checks, and the owner's veto.
- The signed-webhook integration expected a check-start note that B3 retires.
  It now requires its absence and individual-pass suppression, while preserving
  positive failure and whole-head green notes, PR/check facts, and merge closure.

Validation: both targeted corner/webhook reproductions passed; the full
feedback-triage-workflow suite passed (23 tests). Root typecheck, architecture
and workflow-path checks passed. No production mutation was performed; the
08:00Z B1 hold remains in effect.

## Served external-rule correction (firstmate inbox 005)

The R-WAKING-REPORTING failure reproduced against freshly built API-contract
output: its expected sentence predated E1. The expectation now requires the
served commandId order-binding instruction and advertised commandId schema.
The report descriptor also now teaches the existing exact-order binding and
single-order/ambiguous fallback behavior, rather than promising the retired
oldest-order fallback. No handler behavior changed. Existing asker-tag, replyTo,
commander and report-prefix assertions remain.

Validation: API-contract build; full MCP suite (155 tests); external-agent-rules
suite (4 tests); root typecheck and architecture check passed. No production
mutation was performed, and the 08:00Z B1 hold remains in effect.

## Main integration (firstmate inbox 006)

Merged main's database-clock schedule admission, failed-occurrence parking,
usage-owner provenance and event-driven corner checks. Exhausted max_runs still
excludes stopped schedules from both deadline calculation and firing. The locked
merge regression uses main's live checks read and still verifies the stable merge
receipt and later human close. Both main's attachment-deadline regression and
the B2/B4 cleanup regressions remain.

Architecture totals were regenerated from the merged source with the repository's
architecture-invariants and architecture-storage modules; all new schema entries
and accepted contract-drop metadata remain. Per inbox 006, the wording JSON was
regenerated from the merged catalog with the repository's readWordingCatalog and
wordingHashes helper. It is a nonblocking review snapshot: shape/source guards
remain active, while new/changed phrases pass for weekly after-the-fact review.
The old System .jsonc fingerprint and corner declaration locks remain retired.

Validation after integration with main 525dfedb5: all eight server suites passed
(1,407 tests: integration 263, corner lifecycle 234, GitHub operations 136, MCP
162, schedules 24, feedback workflow 23, cleanup 9, System catalog 556). Follow-up
corner state/reference, push-outbox and storage coverage passed 52 tests, with
one opt-in PostgreSQL performance proof skipped. Joined-session 11 and external
rule 4 tests passed against freshly built packages. Root typecheck (workspaces,
mobile and scripts), full build, architecture (20 rules), 24 cleanup/architecture
Node tests, 27 selector/rollout checks, workflow paths and shellcheck passed.
Dead-code baseline holds with zero introduced findings. No production mutation
was performed during integration; B1 remains held until 08:00Z.
