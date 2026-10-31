# Server test selection

PR server shards use TypeScript function locations captured by Vitest's pinned V8 provider. A complete, successful full run on main publishes `server-function-coverage-<commit>`; PRs restore only the map for their exact base from that trusted workflow. Main, merge-group, manual and release execution keep full suites. Existing module-level job filters remain unchanged. A newer main push supersedes an unfinished map collection for the older head.

Selection intersects changed old lines with observed function ranges, then balances selected files across the existing runners. Integration batches use the same selection. Empty shards report their decision without accidentally invoking Vitest without filters. Changed tests and new unmapped tests run themselves; a missing entry for a test already present at the base invalidates the map. Source fingerprints are checked in one git batch.

The map's always-run list includes unlinked tests, direct source readers, compiler/source scanners, and tests observed reading repository source through helpers or launching subprocesses. `system-messages-lock.test.ts` is also mandatory independently of the generated list. A worker hook records only a boolean for source reads and process execution; it records no filenames or contents. Executed browser/process call sites are retained too. Ordinary image reads do not turn an entire application import graph into source-reading guards.

Known always-run tests execute without V8 instrumentation and produce explicit packets after passing. Other tests run with source-read observation and coverage; a helper that reads source becomes always-run even when the test has no direct filesystem import. This avoids profiling the source scanner's TypeScript parser. Full-map workers are bounded to one at a time per runner with a limited JS heap. Dedicated PostgreSQL, corpus and latency gates retain their established behavior.

Missing, incomplete, malformed or stale maps run the full suite. So do setup/config/dependency/shared-package changes, code outside measured server sources, top-level changes, new functions and changes without a covered owner. Insertions examine both adjacent old lines. Markdown changes retain the guards. Maps are build outputs, not committed snapshots, and publish only after every full-run shard succeeds.

## Verification

`node --test scripts/server-test-selection.test.mjs` checks function ownership, guard retention, changed/new tests, insertions, map validity and fallbacks.

`node scripts/prove-server-test-selection.mjs` exercises the actual collector, map merger, PR CLI and Vitest in an isolated repository. It captures two independent functions plus a guard that reads source through a helper. A change selects its function owner and the guard, omits the unrelated test, and exposes both introduced failures. Fixing the function passes the selected tests. A stale map then restores the full suite. Proof identifier: `SERVER-SELECTION-1` (not a defect report).

The real source scanner passed all (140) tests. The collector also passed real runtime/server projection tests and an uninstrumented source-reading test.

## Measured-history replay

Run `node scripts/replay-measured-server-selection.mjs BUNDLE OUTPUT_DIRECTORY MEASUREMENT_CHECKOUT`. The script keeps the delivered bundle read-only, reuses its `prepare-prs.py`, `selection.mjs` and `compare-selection.py`, and writes generated data only to the supplied output directory. Use an ignored directory such as `coverage/measured-final`; do not commit the data.

The indexed replay reproduced the original results exactly at measurement commit `c642ee02`. Its fifty-PR cohort contains no confirmed-real events from the failure ledger. The replay therefore adds the three verified-fix PRs (3115, 2908, 2709), covering all (8) confirmed-real file/job events. All are retained with zero misses. The seven observed source-guard PRs (3125, 3095, 3087, 3081, 3070, 3052, 3050) are retained too. Those seven are observed guard failures, not seven independently confirmed product defects.

The measurement map is a current-main projection, not historical execution coverage. It is stale for every historical PR base. The deployed freshness policy therefore falls back on all (53) replayed PRs. Median and nearest-rank p90 potential savings are (0%) in both serialized test work and PR wall time. The observed successful-run cohort contains (72) runs with median/p90 wall times of (1389.5/1778 seconds). Keeping every job and the longest shard removes no critical-path work. New artifact-restore overhead is not measured, so these are zero potential savings, not a claim of measured unchanged latency.

The preliminary (70.5%) median work projection must not be reported as deployed-policy savings. A usable exact-base map enables selection, as the end-to-end proof demonstrates; deployment benefit depends on fresh maps being available. This replay establishes conservative historical recall and reports the resulting zero savings, rather than waiving freshness to manufacture an improvement.

## Choices

- Exact-base maps from successful main runs only.
- Unknown or partially mapped hunks run everything.
- Shared packages, including api-contract, invalidate selection.
- Test edits select those tests; setup changes invalidate selection.
- Source reads through helpers are observed without replacing filesystem exports with test mocks.
- Ordinary/isolated suite runners and integration batches are pruned; dedicated service gates keep their established execution.
- No tests removed, release edits, nightly tuning or per-PR latency gate.
