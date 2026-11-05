# Accepted audit decisions

This batch implements the captain's accepted recommendations. The code batch
https://github.com/Beeline-Work/beeline/pull/3447 merged after green CI. L1 is
complete. After the previous SSH-attached pass exited, inbox 025 authorized a
single detached continuation: one-row transactions, a 100 ms local statement cap,
and a 20 ms normal pause. Prior cleanup and observer sessions were verified absent
before launch. `nohup` now writes `/tmp/b1.log` on the server; SQL cleanup backend
**1182311** and observer **1182312** are live. At 10:17Z: 24,595 committed cards,
11 timeout skips and zero cleanup-attributed client wait; independent count:
135,522 cards remain.
Cancellation proof passed in 3 ms. No duplicate writer was started. Progress will
be checked from both the durable log and read-only counts; B8 is untouched. See
`b1-detached-progress-25k.json`, `b1-detached-start.json`, and the preceding
`b1-one-row-transport-ended.json`.

| Decision | Implementation |
| --- | --- |
| G1 | `scripts/check-architecture.mjs` reports relaxations for weekly review; candidate rules still must pass. `scripts/ci-workspace-tasks.sh` runs the candidate guard. |
| G2 | System catalog shape and source-use guards remain; phrase changes are reviewed weekly without a wording hash approval gate. |
| G3 | The old System fingerprint lock was already removed. The wording-hash approval gate and corner declaration lock are retired; the catalog guard and exhaustive corner reference replace them. |
| B1 | `scripts/audit-decisions-cleanup.mjs` defaults to `BEGIN READ ONLY`, counts exact D1 classes, and rolls back. `--apply` changes the skill-version job FK to `ON DELETE SET NULL` before deleting jobs, and checks that every skill version survived. Never called by deployment. All 63,964 approved ledger rows deleted and SET NULL preserved all versions; 25,915 cards cumulatively updated. Latest read-back leaves 166,311 cards and 151 fields; stopped above the 150 ms client budget in inbox 021. |
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

## B1 08:00Z preflight stop (firstmate inbox 009)

Fresh restore branch `audit-b1-20261104080017-pre-cleanup` is ready at parent LSN
`A/900B8100`; see `b1-low-traffic-restore-point.json`. The operator stopped before
calling the dry-run cleanup because the SQL `pg_backend_pid()` did not equal
`pg.Client.processID`. A monitor must identify the actual cleanup backend before
its cancellation can be trusted. No retry or apply was made, per the instruction
to stop on any anomaly.

Rows deleted/updated: **0**. Maximum lock wait: **not measured** (monitor never
started). No fresh row counts were collected because the connection guard stopped
before `cleanup()`. `b1-low-traffic-preflight-stop.json` records the aggregate
receipt. Both telemetry tables and all skill versions were untouched. B8 column
drops remain staged and unapplied.

## B1 direct-endpoint retry stop (firstmate inbox 010)

Firstmate authorized retrying with `-pooler` removed from the URL hostname, using
the ready 08:00Z restore point. The operator transformed the connection string
in memory, connected, and ran the PID comparison before setting session limits
or calling the dry-run cleanup. The PID comparison still failed, so the retry
stopped immediately as instructed. No third attempt or production investigation
was made.

Deleted/updated rows across both attempts: **0**. Maximum lock wait remains
**not measured** because neither attempt reached the monitor. Fresh dry-run
counts were not collected. `b1-direct-preflight-stop.json` records this result.
All skill versions and both excluded telemetry tables remain untouched; B8 drops
remain unapplied.

## B1 SQL cancellation proof and skill-key preflight stop (inbox 011)

Firstmate authorized SQL `pg_backend_pid()` as the authoritative identity,
SQL cancellation from the monitor, and termination fallback. A harmless
`pg_sleep(30)` was observed and cancelled with SQLSTATE 57014 in **4 ms** in
both the dry-run session and the intended apply session (limit 2,000 ms). No
protocol BackendKeyData comparison or protocol cancellation was used.

The fresh dry run is `b1-low-traffic-before.json`: 63,964 dead ledger rows,
192,016 note cards with removable keys, all 228 skill versions and 18 job links;
telemetry cohorts retained at 55,862 MCP-audit and 11,700 turn-trace rows.

The intended apply stopped before `monitoredApply`: the operator's additional
original-version preflight incorrectly queried an `id` column. The actual primary
key is `(skill_id,version)` in `apps/server/src/database.ts`. The operator now
uses that composite key. Its local PGlite regression passes, including the case
where a deleted original key is masked by a replacement at unchanged total count.

`b1-sql-preflight-stop.json` records the stop. Deleted/updated rows remain **0**;
maximum lock wait is **not measured** because the lock monitor never started.
No further production retry was made after this anomaly. The ready 08:00Z restore
point remains available. B8 remains staged and unapplied.

## B1 partial apply, stopped on observed lock wait (inbox 012)

The corrected dry run matched every preceding cleanup count and verified all 228
original `(skill_id,version)` keys. SQL sleep cancellation completed in 3 ms in
that session and 8 ms in the apply session. Both satisfy the 2,000 ms limit.
The original ready restore branch from 08:00:17Z was retained as directed.

The separate FK transaction committed as `ON DELETE SET NULL`; its immediate
post-commit monitor sample was clear. The script then autocommitted 40 ledger
batches. The all-backend monitor stopped the run before another batch when it
observed one waiting backend, with **9.745 ms** maximum observed wait over 63
samples. This global observation does not establish that cleanup caused the
wait. No retry, card update, value update, or B8 contract was performed.

| Ledger | Deleted | Remaining |
| --- | ---: | ---: |
| institutional_memory_outcomes | 26,111 | 0 |
| institutional_history_searches | 3,347 | 0 |
| workspace_skill_uses | 9,000 | 580 |
| All other approved ledgers | 0 | 24,926 |
| **Total** | **38,458** | **25,506** |

Read-back confirms all 228 skill versions and all 18 source-job links remain
(the 528 jobs were not deleted). Both retained cohorts are identical before/after:
rooms_mcp_audit **55,908**, agent_turn_traces **11,700**. Later total counts
55,924/11,702 reflect ordinary new writes. All 192,016 note-card updates and 147
other field updates remain pending. The cleanup backend is absent, holds zero
locks and blocks zero clients.

`b1-partial-apply-lock-stop.json` holds the acknowledged per-table changes,
monitor statistics and independent read-back. `b1-low-traffic-before-final.json`
holds the corrected dry run. No further production write is authorized by this
stopped run; firstmate must direct continuation.

## B1 continuation, stopped above revised threshold (inbox 013)

Firstmate changed the stop rule to a client blocked by cleanup for more than
250 ms, or at least three clients blocked by cleanup simultaneously. The monitor
attributes blocking using the authoritative SQL PID and `pg_blocking_pids`,
records duration from `pg_locks.waitstart`, and retains the original own-lock
stop. Unrelated global waits are recorded separately and do not trip this rule.
Threshold boundary, three-client, transient first-sample, SQL cancellation
fallback and composite skill-key regressions passed locally.

The resumed dry run preserved all 228 composite skill keys; SQL cancellation
completed in 4 ms there and 3 ms in the apply session. The apply deleted all
**25,506 remaining ledger rows** and updated **2,875 cards**, then stopped at one
cleanup-blocked client waiting **263.979 ms** (480 samples; global observed max
263.985 ms). There was no termination fallback and no retry.

Independent READ ONLY read-back verifies:

- Every approved ledger predicate is zero: **63,964 cumulative rows deleted**.
- All **228 skill versions** remain. All 18 job links were detached as intended;
  no source jobs remain and the FK reads back SET NULL.
- Retained pre-cleanup telemetry cohorts remain **55,908 MCP-audit / 11,700
  turn-trace** rows. Live totals grew normally to 56,030 / 11,704.
- **189,190** cards still carry the keys in the current live count (net four new
  matching rows since the preceding 192,061-row dry run and 2,875 updates).
- The other **147** field updates remain pending: identities 118, read marks 4,
  needs-you reminders 2, star prompts 23.
- The cleanup backend is absent; it holds zero locks and blocks zero clients.
- B8 drops remain staged and unapplied.

`b1-resume-before.json` records the resumed dry run. `b1-resume-lock-stop.json`
records per-table changes, maxima and independent read-back. Further production
changes await firstmate's direction under the threshold stop rule.

## B1 release pause after quarter-size pass (inboxes 014–015)

Inbox 014 authorized six-row batches (25/4 rounded down), 200 ms pauses, and a
three-row fallback if needed. Local PGlite tests cover both sizes, autonomous
commits, unrelated-card retention, and no rewriting of completed FK/ledger work.
The six-row pass updated **2,076 cards**, then received monitor-initiated SQL
cancellation. It recorded no client blocked by cleanup; its maximum global
observed wait was 31.423 ms. The old zero-wait check for the cleanup's own lock
wait was still present in that run. The operator now applies the explicit
250 ms/three-client rule while its own waits remain bounded by lock_timeout=2s,
but that correction has not been run in production.

Before the three-row fallback began, inbox 015 ordered B1 paused to keep the
messages table clear for the release migration retry. No fallback began. The
completed READ ONLY read-back at 08:43:04Z shows backend 886699 absent, zero locks
held and zero clients blocked by it. That readback connection then closed normally.
No new production call was made after the pause instruction.

Current cumulative state:

- 63,964 ledger rows deleted; every approved ledger predicate is zero.
- 4,951 cards updated (2,875 + 2,076); 187,138 matching cards remain.
- 147 other field updates remain untouched.
- 228 skill versions preserved; 18 source-job links detached.
- Original telemetry cohorts 55,908 / 11,700 unchanged; live totals 56,144 / 11,709.
- Maximum observed cleanup-attributed wait across runs remains 263.979 ms.
- B8 untouched; ready restore point remains audit-b1-20261104080017-pre-cleanup.

`b1-quarter-before.json` records the six-row dry run. `b1-release-pause.json`
records the pass receipt, current counts, release proof and explicit pause.
Further work requires firstmate's resume instruction.

## Nov 5 window: stopped on pre-existing global lock wait (inbox 019)

Firstmate reported v0.1.158, the bounded-standby fix and six valid production
indexes, and explicitly resumed B1 for 08:00Z. The fresh ready restore branch is
`audit-b1-20261105080036-pre-cleanup`, parent LSN `A/EF78DF90`. The operator used
updates-only three-row batches with 200 ms pauses and the new rule: stop on **any
observed lock wait over 1,000 ms or any error**. Nine local boundary, runtime and
batch tests passed before the window. No production call occurred before 08:00Z.

The read-only dry run at 08:01Z verified 187,275 cards, 151 field values and 229
original composite skill keys. SQL cancellation completed in 3 ms in that session
and 4 ms in the intended apply session. The apply's first monitor sample observed
one globally waiting backend at **28,639.227 ms**, with **zero clients blocked by
cleanup** and no lock wait of the cleanup itself. The run stopped before calling
the updates-only cleanup, so no batch or update occurred. No retry was made.

Independent read-back at 08:04:31Z confirms the exact same counts, 229 skill
versions and the SET NULL FK. Today's retained cohorts remain **68,386 MCP-audit /
11,810 turn-trace rows**; later live totals 68,416 / 11,810 reflect new writes.
Backend 1159477 is absent, holds zero locks and blocks zero clients.

`b1-nov5-before.json` records the fresh baseline; `b1-nov5-stop.json` contains the
stop, actual SQL PID, operator-source hashes and read-back. Cumulative B1 changes
remain 63,964 ledger deletions and 4,951 card updates. B8 remains staged and
unapplied. Further production changes await firstmate's direction.

## Nov 5 leader exception and cleanup-client stop (inbox 020)

Firstmate identified the global advisory wait as the bounded leader standby and
authorized excluding exactly application `beeline_long_running`, wait event
`advisory`, and query `SELECT pg_advisory_lock($1)`. SQL tests prove that wrong
applications, events, shared-advisory calls and multi-statement lookalikes are
not exempt. The monitor still stops on any client blocked by cleanup, any other
lock wait above 1,000 ms, or any error. Ten local checks passed.

The refreshed dry run again found 187,275 cards and 151 fields, with all 229
original composite skill keys preserved. SQL cancellation completed in 11 ms
there and 4 ms in the apply session. The updates-only pass used three-row
autocommitted transactions with 200 ms pauses, under the same fresh restore point.

After **7,806 acknowledged card updates** the monitor observed one client blocked
by cleanup for **91.379 ms**, which trips the explicit any-client rule. It cancelled
the cleanup via the authoritative SQL PID and stopped without retry. Maximum
non-exempt wait was 105.686 ms; the excluded leader wait reached 60,042.802 ms.
No fields, FK or completed ledgers were rewritten.

Read-back at 08:24:10Z confirms 179,469 cards and 151 fields remain, all ledgers
still zero, 229 skill versions and SET NULL FK intact, and original cohorts
**68,478 MCP-audit / 11,810 turn-trace** rows unchanged. Live totals grew to
68,587 / 11,810. Backend 1161756 is absent, holds zero locks and blocks zero
clients. Cumulative changes are **63,964 ledger deletes and 12,757 card updates**.
B8 remains staged and unapplied.

`b1-nov5-exception-before.json` contains the fresh baseline;
`b1-nov5-client-stop.json` contains the actual receipt, metadata, source hashes
and read-back. Further production updates await firstmate's direction.

## Nov 5 interaction-budget stop (inbox 021)

Firstmate authorized a 150 ms cleanup-blocked-client budget, retaining the
1,000 ms limit for other non-exempt waits, the exact bounded leader-standby
exception, and the same three-row / 200 ms batches. Eleven local checks pass,
including the actual embedded monitor at exactly 150 ms and just above it.

The refreshed baseline was 179,469 cards and 151 fields, with all 229 original
composite skill keys present. SQL sleep cancellation completed in 4 ms in both
sessions. The pass committed **13,158 card updates** before observing one client
blocked by cleanup for **158.417 ms**, above budget. It cancelled the current
statement and stopped without retry. Maximum other non-exempt observed wait was
258.598 ms; the exempt leader standby peaked at 59,995.437 ms.

READ ONLY read-back at 08:48:28Z confirms **166,311 cards +151 field values**
remain, all ledger predicates are zero, 229 versions and SET NULL FK remain,
and retained cohorts are unchanged at **68,632 MCP-audit / 11,810 turn-trace**
rows. Current live totals 68,797 / 11,810 reflect normal new writes. Backend
1165233 is absent, holds zero locks and blocks zero clients.

Cumulative task changes are **63,964 ledger deletions and 25,915 card updates**.
No other field updates or B8 drops have run. `b1-nov5-150ms-before.json` contains
the baseline; `b1-nov5-150ms-stop.json` contains the actual receipt, source hashes,
maxima and independent read-back. Further updates await firstmate's direction.

## One-row pass and failed pause-change control (inboxes 022–023)

Inbox 022 authorized one-row transactions with SET LOCAL statement_timeout=100ms.
The operator selects a stable primary key, then BEGIN / SET LOCAL / UPDATE /
COMMIT. An UPDATE statement timeout rolls back, increments its timeout count,
pauses one second and advances to the next key. All other errors stop. Only
committed writes are acknowledged. Composite keys and rollback/skip behavior,
including a simulated partial write that ROLLBACK must undo, pass local PGlite
tests. The initially retained successful-row pause was 200 ms.

Inbox 023 reduced that pause to 20 ms, with everything else unchanged. The
prepared operator and regression test now use 20 ms, but no second writer was
started. A separate control connection was intended to cancel the old connection
at its next read-only key-selection boundary, then verify state and restart.
Neither control attempt reached the server: Fly API probing timed out, and a
second explicit-address/org route failed with GraphQL EOF.

The original SSH command remains open but its log has stopped advancing. Last
confirmed receipt: **1,934 committed cards**, **1 timeout**, 1,935 attempted rows,
zero observed cleanup-blocked clients. The PID is the actual SQL backend
**1173283**, not protocol BackendKeyData. The last log timestamp and both control
errors are recorded in `b1-control-connection-gap.json`. Current counts, backend
state and current locks are **not verified**. The original pass may still be
running; do not launch a duplicate. No further control retry was made after the
two failed routes. B8 remains unapplied.

## Firstmate verification: keep original writer running (inbox 024)

Firstmate bypassed Fly and directly verified SQL backend 1173283 committing
(last COMMIT 30 ms before the check), observer 1173284 alive, and no open
transaction. The instruction is to leave the pass running under its original
200 ms rules, skip the 20 ms change, start no duplicate and resume log reporting
when Fly transport returns.

The local prepared configuration was restored to 200 ms; no new writer or
further stop attempt was made. Current data counts are not inferred from stale
SSH output. The last received receipt at this point is 1,971 committed cards
and one timeout in this pass, which is a historical lower bound. The worker is
watching the existing stream and read-only Fly availability.
