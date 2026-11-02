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

## Metafile breakdown after shared JSON consolidation

Actual browser/ESM/minified entry, full staged source. Module contributions are
raw emitted bytes; gzip is measured for the complete output, not added per module.

| Module | Emitted bytes |
| --- | ---: |
| `packages/net/src/private/read-lanes.ts` | 17175 |
| `packages/net/src/private/admission.ts` | 11273 |
| `packages/net/src/private/projection-groups.ts` | 10607 |
| `packages/net/src/private/scheduled-work-authority.ts` | 8151 |
| `packages/net/src/private/command-intents.ts` | 7590 |
| `packages/net/src/private/generated-owner-input-shapes.ts` | 4384 |
| `packages/net/src/private/media-demand-owner.ts` | 3602 |
| `packages/net/src/wire-codec.ts` | 3284 |
| `packages/net/src/private/batch-assembly.ts` | 2571 |
| `packages/net/src/private/saved-windows.ts` | 2546 |
| `packages/net/src/private/tray-group.ts` | 2535 |
| `packages/net/src/private/usage-demand-owner.ts` | 2217 |
| `packages/net/src/private/lane-staging.ts` | 1995 |
| `packages/net/src/private/navigation-owner.ts` | 1592 |
| `packages/net/src/private/compact-wire-shapes.ts` | 854 |
| `packages/net/src/private/projection-codecs.ts` | 500 |
| `packages/net/src/private/owner-inputs.ts` | 377 |
| `packages/net/src/private/staging-bounds.ts` | 315 |
| `packages/net/src/private/canonical.ts` | 0 |

Total: 81850 raw / 23454 gzip. Firstmate instruction 033 resolves the initial
blocker and authorizes consumer-specific entry measurement and state-machine
consolidation without increasing either budget or dropping guards.

## Instruction 033, consumer projection

The phone imports every owner in its aggregate entry. Its new explicit
phone-owner entry therefore remains 81850 raw / 23444 gzip; no runtime code was
excluded to manufacture a pass. The existing package subpath resolves to it.

Helper adapters previously bundled 201041 raw / 32031 gzip bytes
through the full route registry. Their seven closed literal operations now use a
generated complete 260-node input/result projection: 26884 raw / 5926 gzip.
The bundle gate now checks the union of all three helper adapters against the
same 65536 / 16384 limits and refuses unrelated registry imports. Phone limits
and the separate 32768 / 8192 input-observer gate remain unchanged.

## Instruction 033, transition and message-code experiments

| Stage | Phone raw | Phone gzip | Outcome |
| --- | ---: | ---: | --- |
| Explicit full phone consumer entry | 81850 | 23444 | Still over both limits |
| Shared media/usage connection transition table | 82224 | 23606 | Larger; restored smaller implementation |
| 138 diagnostic strings replaced with short codes | 78336 | 22671 | Still over, even excluding the edge text map |

The transition prototype used a single interpreter, explicit offline/online
states, connect/disconnect events and separate guard rows for safe integer,
nonnegative and strictly increasing generation. It replaced the repeated
connection transition in both media and usage owners. All 17 behavioral tests
passed; TypeScript additionally required a connection-presence refinement after
successful interpretation. The larger prototype was not retained. Source capture,
authority, persistence, demand and per-operation guards remained at their original
boundaries; they cannot safely be merged across awaits just to shorten code.

The message-code probe transformed only diagnostic literals (errors, denial/park
messages and error fields/defaults), preserving distinct codes and leaving wire
tags, state names, guards and values untouched. It wrote only in-memory build
output plus a separate edge text map under `.beeline-proof/network-ops/`.
It does not demonstrate a production text migration or claim a bundle pass.
Even this favorable measurement misses by 12800 raw / 6287 gzip bytes.

The explicit phone entry split is committed on both branches; the larger
Tray/Scheduled Work implementation remains staged. The helper-only projection
is independently committed on the combined branch: it includes all helper codecs, preserves their full schemas,
and fits both unchanged consumer limits. The combined branch's smaller phone
slice passing its gate does not close the full staged-phone gate.

All four prescribed approaches have now been measured. The phone budget is still
an implementation blocker. Further reduction requires a deeper redesign of the
read-lane/group/authority implementation; the attempts above have not supplied
one that preserves its asynchronous guards and meets the required size.

Published combined-branch validation regenerates the helper projection against
its current contracts (259 nodes, 26843 raw / 5922 gzip); the older staged worktree
has 260 nodes. The difference includes main's existing removal of the fallback
reviewer enum. Each branch is generated from its own authoritative types.
Combined helper6, consumer bundle3, net build/types, codegen freshness and the
router158/phone72 scanner gates pass. The staged full phone gate still fails.
