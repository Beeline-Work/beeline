# Accepted audit decisions

This batch implements the captain's accepted recommendations. Production was
read-only during implementation. B1 remains a reviewed, explicit one-time action;
its dry run is `b1-dry-run.json`. L1 was the only production write, after
https://github.com/Beeline-Work/beeline/pull/3447 existed. The four rows remain
stored; `l1-stop-and-readback.json` records the stop and independent read-back.

| Decision | Implementation |
| --- | --- |
| G1 | `scripts/check-architecture.mjs` reports relaxations for weekly review; candidate rules still must pass. `scripts/ci-workspace-tasks.sh` runs the candidate guard. |
| G2 | System catalog shape and source-use guards remain; phrase changes are reviewed weekly without a wording hash approval gate. |
| G3 | The old System fingerprint lock was already removed. The remaining wording hash and corner declaration lock are retired; the catalog guard and exhaustive corner reference replace them. |
| B1 | `scripts/audit-decisions-cleanup.mjs` defaults to `BEGIN READ ONLY`, counts exact D1 classes, and rolls back. `--apply` changes the skill-version job FK to `ON DELETE SET NULL` before deleting jobs, and checks that every skill version survived. Never called by deployment. Not applied to production. |
| B2 | Maintenance keeps the latest 200 tool/output activity rows per archived corner, matching `ROOM_VIEW_TOOL_ROW_LIMIT`; leaves open corners, prose and durable facts alone. Scans at most 20 archived corners and deletes at most 1,000 rows per pass; an ephemeral cursor rotates completed slices. |
| B3 | Check-start and individual check-pass notes stop. Whole-head green, failure, conflict and merge notes remain; note IDs retain their dedupe formulas. |
| B4 | Expired claims become terminal `uncertain` after a crashed send, or `failed` for exhausted retries. Active outbox windows survive. Uncertain rows retain an hour before deletion. Expired join devices and notifications are swept in bounded batches after the existing one-hour delivery window. |
| B8 | Redundant corner-note card source/dedupe writes stop. Completed agent-class migration and readers of custom_tags/weight_tier_rules are retired. `scripts/audit-decisions-drop-columns.sql` stages the three drops after every serving and supported rollback image is free of those readers. Compatibility columns stay in schema until that reviewed one-time contract runs; no unsafe rolling drop ships. |
| L1 | `scripts/audit-decisions-schedules.mjs` stops exactly the four accepted schedules without deletion. Exhausted max_runs also prevents future firing in the scheduler. A finite year-9999 next-run time parks the rows safely on older deployed code, which otherwise fires once and deletes them. |
| L3 | Feedback triage instructions open eligible routine fixes without per-item pre-approval. Reviewer PASS plus green checks lands them; the owner keeps a hold as veto. Existing eligibility, product and destructive-action authority remain. |
| E1 | External tools accept explicit commandId, retain that order's human requester and generation, renew its lease per call, and finish on report. A fabricated, wrong-address, wrong-member or live non-MCP claim is refused; expired generations are replaced. Ambiguous legacy report fallback lists orders instead of picking one. |

B5 leaves 30-day webhook replay protection unchanged. B6 lets the correction-repeat
metric age out. B7 keeps writing `rooms_mcp_audit` and `agent_turn_traces`; the B1
one-time historical purge does not disable either writer. L2 leaves stale feedback
items alone. E2 leaves the unused OAuth client to existing 30-day maintenance.
L4 signing-key and E3 session-token rotation are outside this batch.

## Operator commands

`node scripts/audit-decisions-prod-read.mjs` runs only B1 aggregate counts on the
existing server machine; it does not upload files or expose credentials.
`node scripts/audit-decisions-schedules.mjs` reads only the four schedule summaries.
After the PR is up, `node scripts/audit-decisions-schedules.mjs --stop` performs
L1, followed by the read-only command for independent read-back.

B1 execution requires firstmate to obtain the captain's explicit yes on the
reviewed script. Run `scripts/audit-decisions-cleanup.mjs --apply` with the existing
database environment, never a URL in argv. B8 column drops must wait until the
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
