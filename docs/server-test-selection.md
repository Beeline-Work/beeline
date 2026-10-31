# Server test selection

PR server shards use TypeScript function locations captured by Vitest's pinned V8 coverage provider. A complete, successful full run on main publishes `server-function-coverage-<commit>`; PRs restore only the map for their exact base commit from that trusted workflow. Main, merge-group, manual and release execution keep full suites. Existing module-level job filters remain unchanged.

The map records which test files executed each function. Selection intersects changed old lines with those function ranges, then balances the selected files across the existing runners. Integration batches use the same selection. An empty shard exits after reporting its selection instead of accidentally asking Vitest to run every test.

Always-run tests include every test with no covered server function, and every test whose local import graph contains file reads, subprocess execution or browser automation. This is deliberately broader than source-reading guards: a helper can hide an external dependency from coverage. `system-messages-lock.test.ts` is included. The separately gated PostgreSQL, corpus and latency checks retain their current execution.

The full collector executes known always-run tests without V8 instrumentation and records explicit always-run packets after they pass. Their function attribution cannot prune them, so profiling them adds cost without improving selection. This also avoids instrumenting the source scanner's TypeScript parser.

Missing, incomplete, malformed or stale maps run the full suite. So do test edits, setup/config/dependency changes, code outside the measured server sources, top-level changes, new functions and changes without a covered function owner. Insertions examine both adjacent old lines. Maps are short-lived build outputs, never committed snapshots, and are published only after every full-run shard succeeds.

## Verification

`node --test scripts/server-test-selection.test.mjs` exercises fallback and guard retention.

`node scripts/prove-server-test-selection.mjs` exercises the actual collector, map merger, PR CLI and Vitest in a disposable git repository. It captures two independent functions and a source-reading guard; changes one function; verifies selection catches both a runtime failure and a source-guard failure while omitting the unrelated test; fixes the change; and verifies the selected tests pass. A stale map then restores the full suite. Proof identifier: `SERVER-SELECTION-1` (not a defect report).

The measurement brief references a report and replay bundle that are not present in this checkout or at its supplied recovery path. Its summary establishes historical source-guard misses on PRs (3125, 3095, 3087, 3081, 3070, 3052, 3050). The regression retains that guard for all of them. This regression is not a substitute for replaying the original measured histories, per-function coverage and critical-path timing data. Historical zero-miss and median/p90 savings acceptance remains pending that replay; no savings are claimed from the smaller functional proof.

`node scripts/replay-server-test-selection.mjs` reconstructs the last fifty merged server PRs at measurement commit `c642ee02`. Without the missing coverage index, this verifies the production full-suite fallback for all fifty PRs and retains all seven recorded guards. Median and p90 savings in both test time and PR wall time are consequently zero: no work is removed. This fallback-only result does not establish the preliminary measurement's optimized-selection benefit or recall. Supply a coverage-index path as its first argument to exercise map validity against those historical bases.

## Conservative choices

- A map must match the exact PR base, rather than guessing whether an older function identifier is still valid.
- Unknown and partially mapped hunks run everything, rather than omitting their unowned lines.
- Shared package changes, including api-contract, run everything.
- Local transitive file reads are always-run even when coverage also links those tests to runtime functions.
- Only the ordinary and isolated suite runners and integration batches are pruned. Dedicated service and performance gates retain their established behavior.

These choices favor failure detection over the preliminary measurement's projected savings. They may substantially reduce savings, especially while main advances faster than complete maps can be published.
