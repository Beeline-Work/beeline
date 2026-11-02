# Staged owner bundle budget blocker

The full staged entry remains `packages/net/src/private/admission.ts`; measurements
bundle all exports with the unchanged browser/ESM/minify esbuild configuration in
`scripts/network-codec-bundle.test.mjs`. Neither the entry nor budgets changed.

| Attempt | Raw bytes | Gzip bytes | Result |
| --- | ---: | ---: | --- |
| Starting staged core | 82874 | 23654 | Fails 65536 / 16384 limits |
| Shared synchronous gesture lifetime helper | 82640 | 23644 | Reverted: only 10 gzip bytes saved |
| Shared bounded JSON traversal | 81850 | 23454 | Retained; 65 focused tests and net types pass |

The retained change removes the second descriptor/cycle/prototype traversal used
for canonical admission keys. It preserves sorted keys, undefined-field handling,
UTF-8 bytes, accessor refusal, and the distinct local-key/wire node/depth limits.
Its four new tests cover those boundaries; existing admission, command intent,
Tray, media/usage owner, phone and helper codec suites all pass (65 tests total).

The remaining deficit is **16314 raw / 7070 gzip bytes**. A separate in-memory
experiment even mangled every property, including unsafe wire/public properties,
and still measured 21463 gzip bytes before the retained refactor. That experiment
changed no source or build configuration and must not ship. Identifier shortening
is insufficient; the required state-machine implementation needs architectural
consolidation. The worker has not found a safe design for that remaining reduction.

Per the task's repeated-obstacle rule, this is reported as blocker
`owner-bundle-budget`. Firstmate engineering assistance is needed on the core
architecture; no permission to raise budgets or remove safeguards is requested.
The smaller published combined slice still passes its existing bundle tests;
that does not satisfy the full staged-core gate. Activation, cohort proofs,
migrations, T7 and the router-only removal sweep remain incomplete.
