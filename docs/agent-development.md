# Development and CI invariants

Paths and commands below are relative to the repository root. Read these invariants before editing this area; named code and tests hold implementation detail.

## Branch conventions and CI

- `fm/*` branches stack: check `gh pr list --json baseRefName,headRefName` before assuming a file is on `main`. A stack merged base-first does not propagate; re-target to `main` and verify with `git grep <symbol> origin/main`.
- Never stage git-ignored `relay-stack/web/dl/` bundles.
- Resolve merges as one batch: list every textual conflict and semantic overlap, resolve them in one pass, then run one integration matrix.
- **`TYPECHECK` (root `npm run typecheck` = turbo + `apps/mobile` + `tsconfig.scripts.json`) and `SHARED PACKAGE TESTS` run on every PR.** Two green PRs can still merge into a red `main`; after changing a shared row type, merge `origin/main` and re-run typecheck.
- **In `checks.yml` a job `name:` is a required check context.** Never rename one; skip only with a job-level `if:`; every gate must execute something. Heavy suites filter by module path; `packages/**` runs everything. `npm run lint:workflow-paths` fails a workflow naming a test path nothing matches.

## Dead code and lifecycle proofs

- **Dead code is baseline-gated.** After building workspace `dist/`, `npm run dead-code` runs Knip against `knip-baseline.json`; only run `dead-code:baseline` for an intentional API addition. Expo Router entries are declared in `knip.jsonc`.
- **Hand-testing `beeline start`/`pair` in a worktree can start a REAL production daemon** (runtime pointers live in the shared git common dir; `start-command.ts` converges the machine helper). Lifecycle tests require isolated `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and a separate native manager; use `scripts/helper-proof/run-linux.sh` for real installation/start/update tests. `lifecycle-test-guard.ts` refuses live paths and unmocked managers in tests. Use `--repo` a throwaway repo for `pair`.

## Product naming

**Naming.** The product is **Beeline**; write "Beeline" in prose, docs, and UI copy. `buzz`/`Buzz` survives only as a legacy code identifier (`apps/mobile/sources/buzz/`, `components/buzz/`, `@beeline/buzz-client`, `BuzzClient`, `BuzzRigTransport`, `theme.buzz`, `BUZZY_RELAY_*`, the `buzz-dm`/`buzz-community-invite` wire tags). Quote those verbatim; never call the app Buzz or Buzzy. Wire tags must not be renamed.
