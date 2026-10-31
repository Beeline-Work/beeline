# Incident coverage added after the CI measurement

The final commander order includes model capacity, merged-PR handoffs, running-work lifetime, and the two PostgreSQL deadlocks. It excludes pool teardown. Existing injected-deadlock tests and previously covered incidents remain intact.

## Production evidence read

- `Beeline-Work/beeline-insights` `problems/model-capacity-no-retry.json` and `problems/merge-handoff-after-merge.json` were read through the owner's sealed GitHub read credential. The capacity diagnostic completed a review successfully instead of triggering a retry. The merge reports describe ready-to-land instructions followed by already-merged/closed refusals. `docs/corner-gate-oct30-replay.md` records the earlier production replay and its narrower merge-gate test.
- `problems/wakes-kill-running-work.json` at Insights commit `183ad3622f3ebc8f383ffe9beea7f8139e87bd6e` records repeated wakes stopping running turns and killing their development resources after the earlier fix shipped. The entry no longer exists on Insights main; its historical version was read before adding the replay.
- Sentry latest events for BEELINE-SERVER-1W (`7821113894`, October 30, 22:06 UTC) and BEELINE-SERVER-1V (`7820877464`, October 31, 01:48 UTC) were read using the owner's sealed Sentry credential. Both report `deadlock detected`; the stacks identify the GitHub operations transaction and reviewer lifecycle locking respectively. No production state was changed.

## Reproductions and fail-before proof

| Incident / reproduction | New test | Planted incident bug and observed failure |
| --- | --- | --- |
| model-capacity-no-retry | `ACP provider diagnostic reaches durable recovery and retains the original work` in `corner-review-dispatch.test.ts` | Disable `recoverModelCapacityCompletion` at the completion boundary. A real ACP subprocess emits the exact final capacity text with `end_turn`; the actual durable completion receipt no longer requests a hiccup retry. |
| MERGE-HANDOFF-AFTER-MERGE | `checks event` and `stale landing wake` in `github-operations.test.ts` | Restore `github-operations.ts` from main `af61a8d05`. Both cases fail the landed assertion: a provider-confirmed merged PR leaves the corner open. This uncovered a current bug; it was reported needs-decision before the narrow fix. |
| wakes-kill-running-work | `ordinary wakes and a revised brief retain the server and emulator lease until explicit Stop` in `server-command-intake.test.ts` | Plant cancellation when another ordinary input arrives while busy. The actual intake cancels the active ACP subprocess work and the test fails. |
| BEELINE-SERVER-1W | `concurrent refreshes recover a PostgreSQL deadlock and commit one rollup event` in `incident-deadlocks.test.ts` | Set the owning refresh's retry budget to one. PostgreSQL emits SQLSTATE `40P01`; the public checks-event path rejects instead of recovering. |
| BEELINE-SERVER-1V | `receipt and reassignment recover a PostgreSQL deadlock with one atomic fallback` in `incident-deadlocks.test.ts` | Disable owning daemon-transaction replay. PostgreSQL emits SQLSTATE `40P01`; the failed receipt rejects instead of committing one fallback assignment. |

Each mutation was applied separately, run to a failing test, and restored before passing validation. Both merge tests also failed directly on the unchanged starting main. The tests are not disabled or marked expected-failure.

The real PostgreSQL cases use a new throwaway database on loopback and migrate once. Two genuine transactions form a controlled cycle around the production lifecycle lock and a test-only advisory lock. PostgreSQL chooses the victim; no JavaScript deadlock exception is injected. The second transaction models a writer that acquired its lock first. Assertions verify lifecycle-before-row lock order, bounded recovery, rollback/replay, one committed failure event and work command, and one idempotent fallback assignment. These complement rather than replace the existing injected exhaustion tests.

## Demonstration and limits

The safe stand-ins for historical production events use synthetic identities and provider responses. The capacity case runs the body ACP adapter over a real subprocess, forwards its final output and completion into the actual daemon receipt path, releases the existing durable retry deadline, redelivers the same request and original work, and completes the retry. Receipts are not mocked.

The lifetime case runs the production intake with pushed ordinary commands and a brief-revision command, while a real ACP subprocess owns a loopback development server and the production emulator lease owns its marker. The simulated upstream brief writer updates a file that the working server reads; its response shows the latest revision without ending the turn. Explicit Stop cancels the prompt. Android guest boot and the production brief-write API are outside this narrow lifetime stand-in; the lease, subprocess, server, file reads and intake are real. A turn stop retains the corner-owned lease until fixture cleanup.

The merge cases exercise the production checks event and the live checks read used by a stale landing wake. Both reconcile through the existing idempotent archival path, record the merge, and leave no active corner work or second merge API call. `node --import tsx scripts/prove-review-capacity.mjs`, after building the server, also demonstrates authenticated built HTTP checks read → landed outcome and archived corner → another read with mergeAllowed false. It does not claim a live phone or GitHub merge.

The PostgreSQL cases run in the existing SERVER CLAIM LATENCY job's PostgreSQL service via `BEELINE_INCIDENT_TEST_POSTGRES_URL`. Ordinary suites discover the file but skip those cases without the explicit loopback URL. No release workflow or required check name changed.

## Validation

All new cases passed in five independent runs with one worker. Each run includes the real PostgreSQL migration, both deadlock cases, both merge paths, the ACP-to-receipt capacity retry, and running-work lifetime. Conservative sums of the complete server and body invocations were 32.00, 34.79, 29.70, 38.68 and 33.77 seconds on the shared local host. Even the slowest sum is below the 60-second added-CI budget; this includes fixture/startup costs that existing test-file jobs already pay. These are local measurements, not a claim of measured hosted-CI duration.

Repeat with a disposable loopback PostgreSQL URL:

```sh
BEELINE_INCIDENT_TEST_POSTGRES_URL=postgres://postgres:isolated-proof@127.0.0.1:PORT/postgres npm test -w @beeline/server -- --run src/incident-deadlocks.test.ts src/github-operations.test.ts src/corner-review-dispatch.test.ts -t 'BEELINE-SERVER-1W|BEELINE-SERVER-1V|MERGE-HANDOFF-AFTER-MERGE|model-capacity-no-retry' --maxWorkers=1 --minWorkers=1
npm test -w @beeline/body -- --run src/server-command-intake.test.ts -t wakes-kill-running-work --maxWorkers=1 --minWorkers=1
```

Root typecheck, workflow-path validation, the complete command-intake file (27 tests), both full affected server files (218 tests), and both built merge proofs passed. Both built merge triggers can be demonstrated separately:

```sh
npm run build -w @beeline/server
node --import tsx scripts/prove-review-capacity.mjs
node --import tsx scripts/prove-review-capacity.mjs --merge-webhook
```
