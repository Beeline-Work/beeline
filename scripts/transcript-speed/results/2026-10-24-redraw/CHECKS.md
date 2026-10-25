# Validation

- `npm run corner:prepare`: passed.
- `npm run typecheck`: passed after the scoped-action and handoff changes.
- `npm run lint:ui-components`: passed (569 source modules; 174 shared components).
- `npm run lint:workflow-paths`: passed (59 workflow paths).
- `npm run dead-code`: passed (4 pre-existing findings; none introduced).
- Full mobile suite with two workers and 10-second test timeout: 612 files passed; the remaining unread-boundary static assertion was updated to follow the memoized folder call and its entire file passed on rerun (7 tests). The suite ran 5,391 passing tests before that rerun.
- Focused canonical-window, cell, folded-card and related regression files: passed. Final handoff/session run: 88 tests passed. Scoped callback identity and old-Room isolation: 6 tests passed. Card-motion/row tests: 29 tests passed.

The full mobile run excluded only `accepts this tree and rejects a real native edit, end to end`, using `--testNamePattern='^(?!.*accepts this tree and rejects a real native edit, end to end)'`. That fingerprint case fails on the untouched PR 2913 tree as well: recorded iOS hash `831938dc46dab9517152283c79603577d5765008`, locally computed `dd2a82afc91da03eff2220ee359aa09055eeaf98`. Android remains `1c79c05996990e45972da74d27e1382577a8608f`. Native fingerprints and the CI gate were not changed. Native-import coverage timed out in an earlier full run and passed its focused rerun.

The Android release app and visible-path capture are additional evidence; unit tests alone do not establish the displayed result. Both comparison APKs use Hermes, Fabric, the measurement hooks and a disabled React Compiler. The final release build uses the repository's fixture signing configuration and local fixture services only.

## CI repair after first review handoff

The first PR head's mobile suite passed 612 files and 5,399 tests, but the corner-forward source assertion still searched for `handleForwardToNewCorner` after the renderer moved to `rowActions.handleForwardToNewCorner`. Its failed string search produced an empty gate. Update the assertion to follow the scoped callback, explicitly reject a missing match, and preserve the same Room/corner forwarding permission assertions. The complete affected file passes (3 tests). No product behavior changed in this repair.

`FRAME-BUDGET` and `STATE-UPGRADE` failed only because they derive their verdicts from the mobile suite; their logs contain no separate failing test. The gate definitions are unchanged. The harness measurement tests also pass (4 tests).
