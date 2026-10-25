# Validation of page-local desktop widths

- `npm run corner:prepare`: passed.
- Root `npm run typecheck`: passed, including mobile and scripts.
- `npm run lint:ui-components`: passed.
- Full mobile suite: completed (619 files; 608 passed, 5 skipped, 6 initially failed). The failures were viewport-context mocks and the connection test's exact style-array comparison. Those fixtures were corrected without changing their behavior assertions; all six complete files then passed (83 tests). The connection inset test now checks the flattened geometry and additionally requires no phone maxWidth.
- Broader affected-route run: remaining app/connection fixture failures were corrected and the complete files passed in a follow-up run (32 tests).
- New desktop page width browser regressions: passed at 500, 1280, 1440 and 1920 px (12 tests), including populated schedule list/detail paths. Real page components, fonts and synthetic service responses; screenshots and JSON under `pages/`.
- Desktop sheet browser reproduction: baseline and changed components passed the expected before/after assertions at 500, 1280, 1440 and 1920 px (8 cases). Permanent current-component regression coverage passed in the full suite. Screenshots and JSON under `sheets/`.
- `node apps/server/scripts/run-ci-shard.mjs 1/4`: passed (53 files, 781 tests passed, 1 skipped).
- `git diff --check`: passed.

The full mobile process's original exit was nonzero; the corrected fixture files were rerun to completion afterward. This is not a claim that a second full-suite process was run after the fixture-only corrections.

Production before measurements for every route, the complete required screenshot matrix, reviewer-bypass sign-in and shared token integration remain outstanding. See inventory.md for the browser routes attempted and their results. This work is a draft pending those proofs and Ruby's rebase order after PR #2915.
