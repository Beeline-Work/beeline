# Group B PostgreSQL proof report

Scope: F01, F12, F14, F15, F16, F17, F19 and F22. All listed executable candidate-path proofs pass on isolated loopback PostgreSQL. No production access, real Fly lifecycle action, UI or capability activation was used. The integrator owns the closure ledger.

**Whole-finding Closed: none. Still Open: all eight.** The specification also requires complete consumer/cohort, ownership and equal-workload acceptance; the supported candidate subset is not whole-finding closure. In particular, old helper receipt/draft adapters remain deliberate compatibility paths. The report distinguishes passing P12 obligations from those remaining gates instead of claiming that disabled infrastructure closes the audit.

| Finding | Passing executable proof and result | Remaining whole-finding gate |
| --- | --- | --- |
| F01 | `helper-overlay.postgres.test.ts`, `P12 helper`: 1,000 hidden updates upload no frames/rows; committed viewing admits one fresh helper baseline across PostgreSQL pools; UTF-8 append/reset/terminal fences pass. Existing wire variant covers a missed revision and late resurrection. | Actual released helper/phone and complete legacy/new transport composition; the preserved legacy Body adapter still posts full drafts. |
| F12 | `turn-ownership-socket.test.ts`, `binds the actual registration`: ten minutes, unchanged command/turn/binding versions, turn freshness writes 0/deltas 0, empty per-agent checkpoints 0, ≤20 aggregate owner writes. Owner loss/requeue/new-generation and default-off cases pass on PostgreSQL. `turn-ownership{,-authority}.postgres.test.ts` retain replacement, current-authority and commit-expiry fences. | Legacy freshness floor, complete model/provider-effect ownership and full cost/cohort matrix remain required. |
| F14 | `turn-ownership-socket.test.ts`, `F14 scopes 1,000 irrelevant facts`: two real subscribed agents, actual PostgreSQL LISTEN and a new committed command; unrelated turn/activity inbox reads 0, correct-target command read 1, peer updates 0, claim succeeds. | Complete source and released old/new-helper matrix; this is not a claim about every historical server image. |
| F15 | `rooms-mcp-stream.test.ts`: 8 PGlite/PostgreSQL cases, idle day SQL/transactions/empty frames 0, real committed delivery, rollback suppression, current-token revocation, unchanged-cursor resume. Actual Body inbox persistence/crash dedupe precedes checkpoint. `session-join/member-stream.test.ts`:6. | Complete installed Body/member-stream compatibility floor; retained explicit `pollOnce` and older installed bridges are not reported as migrated. |
| F16 | `background-deadlines.postgres.test.ts`:5, using the actual production repair-family factory plus actual push/check-in/free-agent owners. Idle day SQL/provider 0, committed calendar/retention input runs only that family, takeover initializes once, exact microsecond admission cut prevents scan/deadline gaps. Choice/schedule8 and leader PostgreSQL2 retain due-family and ownership coverage. | Complete job-generation/provider ownership, workload and supported cohort composition remain separate gates. The reproduced recurring-scan defect is fixed. |
| F17 | `computer-expiry.test.ts`:6, no empty-day discovery/provider work, actual committed expiry ends once and newer versions win. `voice-budget.postgres.test.ts`:2, crash-before-ack and takeover have no lost/double charge or stale enqueue. Background deadline 5 includes actual PostgreSQL lease-renewal/terminal controls with recovery reads 0, baseline race and one synthetic failed-stop admission. Background ownership PostgreSQL4 retains physical owner fences. | Physical/provider voice and complete production ownership-generation/accounting/cohort composition remain unproved. No live Machine was driven. |
| F19 | `helper-overlay.postgres.test.ts`, `P12 helper`: 100 UTF-8 appends carry exactly the final text's UTF-8 byte length plus bounded framing/reset. `helper-activation.postgres.test.ts`:100 concurrent duplicate setup consumers read one context, and current grant revocation blocks final enqueue even with that held value. | Complete monolith/provider adapters, legacy growing-snapshot cohort and equal-workload CPU/WAL acceptance. |
| F22 | `npm run prove:router-group-b`: real PostgreSQL strict audit passes, recurring registrations0/failures0. `group-b-recurring-inventory.json` classifies all 55 Appendix D1 mechanisms, all 6 D2 workflows and all 18 repair suboperations by exact owner/source/proof. Socket test makes 60 actual `/readyz` requests with database reads 0. `connector-squire.test.ts`:60, including one GET per admitted setup observation and idle-day silence. | Complete cross-group transport/vendor/SDK, ownership, rollout and workload gates; inventory is not a blanket scheduler exemption. |

## Defects fixed by the proof

The first strict real-PostgreSQL run measured 21 direct maintenance statements and 2 check-in discovery statements at the first settled idle minute, versus required 0. The production entrypoint still registered check-in/push/repair every 60 seconds and free-agent work every 15 seconds.

These four registrations are now deadline/event-owned. The repair bucket is split into 20 independent retention table minima and separate sign-in, mention, MCP routing, reviewer, voice, media, lease, notice and curator families. Committed source triggers watch each family's actual columns; content-only/no-op updates do not create generic repair work. Known voice lease extensions update local deadline evidence without recovery SELECTs. A detached check-in keeps its shutdown drain and computes its stored next deadline after completing work.

An exact PostgreSQL timestamp, retained as text at microsecond precision, precedes each admitted family scan. The next minimum includes a record that becomes due during that scan, while an older failed record stays parked. Failed helper sleep episodes and public-page readiness observations no longer retry on elapsed time. Squire still publishes its reported sign-in result; no UI or consent behavior was added.

These are selected correctness and admission proofs, not a production CPU/WAL/paint acceptance claim. The actual due owners retain existing domain/authority locks; private aggregate-generation composition remains governed by its separate rollout gates.

## Reproduce and validation

Use a disposable loopback PostgreSQL16 database with CREATE DATABASE permission; every full fixture creates and drops its own random database. Set `BEELINE_COMMAND_TEST_POSTGRES_URL` (and the same URL in `BEELINE_VOICE_TEST_POSTGRES_URL` for voice). Vitest suites run serially with `--maxWorkers=2 --minWorkers=1`. Only the business clock/scheduler is driven; Node, pg and socket control timers remain real.

```sh
npm test -w @beeline/server -- src/background-deadlines.postgres.test.ts --maxWorkers=2 --minWorkers=1
npm test -w @beeline/server -- src/turn-ownership-socket.test.ts --maxWorkers=2 --minWorkers=1
npm test -w @beeline/server -- src/helper-overlay.postgres.test.ts --maxWorkers=2 --minWorkers=1
npm test -w @beeline/server -- src/helper-activation.postgres.test.ts --maxWorkers=2 --minWorkers=1
npm test -w @beeline/server -- src/rooms-mcp-stream.test.ts --maxWorkers=2 --minWorkers=1
npm test -w @beeline/server -- src/computer-expiry.test.ts --maxWorkers=2 --minWorkers=1
npm test -w @beeline/server -- src/choice-expiry.test.ts --maxWorkers=2 --minWorkers=1
npm run prove:router-group-b
```

Fresh candidate suites: deadline 5/socket 10/overlay 2/activation 1/MCP 8/computer 6/choice 8/shutdown 11. Existing background 40/check-in 32/work 11/completion 3, real PostgreSQL leader 2/ownership 4/turn 1/current-authority 1/MCP-authority 1/voice 2 and Body idle 5/overlay 2/context 3/member-stream 6/heartbeat 10/Squire 60 pass. Full typecheck, server build, architecture 20, router-boundary 27, router inventory and workflow-path checks pass. Dead-code retains 5 existing findings and introduces 0; its baseline is unchanged. The isolated PostgreSQL CI lane includes the new serial suites; required check names and budgets are unchanged.

Shared changes outside the proof files are the family source/deadline composition, notification-family control dispatch, existing-owner scheduler injection, the refused-idle guard and the single Squire readiness leaf shared with F21. The manual Group A closure-gate command and exact Knip entrypoints make its already-documented executable suite reachable without changing a baseline or assertion.
