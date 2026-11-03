# Development and CI invariants

Paths and commands below are relative to the repository root. Read these invariants before editing this area; named code and tests hold implementation detail.

## Branch conventions and CI

- `fm/*` branches stack: check `gh pr list --json baseRefName,headRefName` before assuming a file is on `main`. A stack merged base-first does not propagate; re-target to `main` and verify with `git grep <symbol> origin/main`.
- Never stage git-ignored `web/dl/` bundles.
- Resolve merges as one batch: list every textual conflict and semantic overlap, resolve them in one pass, then run one integration matrix.
- **`TYPECHECK` (root `npm run typecheck` = turbo + `apps/mobile` + `tsconfig.scripts.json`) and `SHARED PACKAGE TESTS` run on every PR.** Two green PRs can still merge into a red `main`; after changing a shared row type, merge `origin/main` and re-run typecheck.
- **In `checks.yml` a job `name:` is a required check context.** Never rename one; skip only with a job-level `if:`; every gate must execute something. Heavy suites filter by module path; `packages/**` runs everything. `npm run lint:workflow-paths` fails a workflow naming a test path nothing matches.
- **Checks reuse deterministic work and select conservatively.** `.github/actions/ci-workspace` restores lockfile-keyed dependencies and cross-commit Turbo build/typecheck tasks, but final compiled archives require exact-SHA file-hash provenance. Test verdicts are never cached. `scripts/workspace-test-selection.mjs` propagates file dependencies for Body/mobile; the existing server coverage selector retains always-run source scanners and full fallbacks. Required names and assertions stay stable. Each main merge runs full checks and publishes coverage from those same executions, without cancelling earlier merges; failures reach the existing fix-loop reporter. Commands, role budgets and measurement limits: [CI capacity](ci-runner-capacity.md), `scripts/ci-workspace-tasks.sh`, `apps/server/scripts/run-ci-shard.mjs` and `apps/server/scripts/ci-test-timings.json`.

- **PR capacity uses both hosted and isolated CI-only runners.** PR detection, preparation, selection and verdicts use the one-CPU CI control listener; keep privileged setup and the PostgreSQL claim-latency budget hosted. Only the credential-free `beeline-ci` pool may run heavy Linux PR jobs, with the service and slice limits in `infra/ci/` installed before enabling listeners; never substitute production/Android release labels. See [runner isolation and measurements](ci-runner-capacity.md). Checks and Desktop already cancel superseded PR heads; non-PR runs remain independent.

- **Server fake clocks leave Node's I/O scheduler native.** `apps/server/vitest.config.ts` mocks application timers and Date, preserving `setImmediate`/`clearImmediate`. An in-flight network callback can create a fake handle that real cleanup later cancels, corrupting Node's immediate accounting and stranding hooks/RPCs. The cross-clock cleanup regression is in `scripts/ci-shards.test.mjs`.

## Dead code and lifecycle proofs

- Write corner evidence under `.beeline-proof/` and publish evidence needed after close. The manifest labels provenance only: a confirmed archived corner deletes all per-corner data, including proof, dirty work and unpushed commits, after stopping attributable processes. Open/unknown corner lifecycle never authorizes archive deletion.
- After building the body, `node scripts/prove-archived-output.mjs` demonstrates `ARCHIVED-OUTPUT-1` through the built storage report and archive sweep in a throwaway checkout, including a live child and dirty source.

- **Test database teardown releases the engine.** `PgliteDatabase.close()` in `apps/server/src/test-support.ts` drains background work, closes PostgreSQL, then drops the PGlite engine reference. Vitest 2 instance spies retain old services and wrappers; keeping a closed engine attached retains its WASM heap. Coverage: `test-support.test.ts`.

- **Dead code is baseline-gated.** After building workspace `dist/`, `npm run dead-code` runs Knip against `knip-baseline.json`; only run `dead-code:baseline` for an intentional API addition. Expo Router entries are declared in `knip.jsonc`.
- **Hand-testing `beeline start`/`pair` in a worktree can start a REAL production daemon** (runtime pointers live in the shared git common dir; `start-command.ts` converges the machine helper). Lifecycle tests require isolated `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and a separate native manager; use `scripts/helper-proof/run-linux.sh` for real installation/start/update tests. `lifecycle-test-guard.ts` refuses live paths and unmocked managers in tests. Use `--repo` a throwaway repo for `pair`.

## Product naming

**Naming.** The product is **Beeline**; write "Beeline" in prose, docs, and UI copy. `buzz`/`Buzz` survives only as a legacy code identifier (`apps/mobile/sources/buzz/`, `components/buzz/`, `@beeline/buzz-client`, `BuzzClient`, `BuzzRigTransport`, `theme.buzz`, the `buzz-dm`/`buzz-community-invite` wire tags). Quote those verbatim; never call the app Buzz or Buzzy. Wire tags must not be renamed.

## Preparing a corner

`npm run corner:prepare` installs root dependencies only. Add `-- --mobile` for mobile work, `-- --build` when compiled workspace outputs are needed, or `-- --mobile --build` for both. Root typecheck includes mobile, so its first run in a fresh checkout needs both options. On a sandboxed repository corner, the helper prepares root dependencies before activation and mounts the shared generation read-only; preparation preserves that tree. `--mobile` records a request for automatic mobile preparation at the next turn. Outside managed sessions, preparation uses a private `npm ci`. Change dependencies with `npm install --package-lock-only --ignore-scripts <package>`; the changed lockfile automatically replaces the session and its mounts on the next turn. See [shared dependency generations](shared-dependency-generations.md).
