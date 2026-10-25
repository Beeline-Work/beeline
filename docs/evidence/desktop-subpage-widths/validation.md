# Validation of page-local desktop widths

- `npm run corner:prepare`: passed.
- Root `npm run typecheck`: passed, including mobile and scripts.
- `npm run lint:ui-components`: passed.
- `npm run dead-code`: passed after explicitly registering the esbuild browser proof entry in Knip (4 existing findings, 0 introduced; no baseline change).
- Full mobile suite rerun after the fixture corrections: passed (614 files passed, 5 skipped; 5413 tests passed, 6 skipped).
- New desktop page width browser regressions: passed at 500, 1280, 1440 and 1920 px (12 tests), including populated schedule list/detail paths. Real page components, fonts and synthetic service responses; screenshots and JSON under `pages/`.
- Desktop sheet browser reproduction: baseline and changed components passed the expected before/after assertions at 500, 1280, 1440 and 1920 px (8 cases). Permanent current-component regression coverage passed in the full suite. Screenshots and JSON under `sheets/`.
- `node apps/server/scripts/run-ci-shard.mjs 1/4`: passed (53 files, 781 tests passed, 1 skipped).
- `git diff --check`: passed.

The original fixture failures are resolved; the full mobile rerun completed successfully.

Production before measurements for every route, the complete required screenshot matrix, reviewer-bypass sign-in and shared token integration remain outstanding. See inventory.md for the browser routes attempted and their results. This work is a draft pending those proofs and Ruby's rebase order after PR #2915.
