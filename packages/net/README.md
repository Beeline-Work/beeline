# Beeline network admission

This package stages local admission, read lanes and durable command intents for the network router. The server defaults all new capabilities off; the operation inventory retains migration debt until complete consumer/cohort proofs pass. Its compiler-checked leaves match both operation maps. No public executor, URL fetcher, pass factory or recovery factory exists.

The private owner entry is allowed only in the exact mobile navigation and persisted-command owners enforced by `scripts/router-boundaries.mjs`. The navigation owner observes committed navigator residency; consumers observe/refcount lanes without minting passes. List, count and Room-head choose exactly one legacy/router path per negotiated epoch. Command intents persist immutable bytes and identity before dispatch and cannot downgrade an uncertain result. Web cross-tab ownership and upload-dependent prepared identities remain explicit gates.

LiveConnection negotiates on its existing socket, queues bounded committed pushes until the local owner is ready, and selects legacy from an old-server acknowledgement without a fallback timer. Foreground and duplicate reachability samples preserve an open socket. Slow requests and foreground inactivity use the same ping challenge; only native loss or an unanswered challenge declares the connection dead. Production callers receive a frozen operation facade without the constructor, socket or disposal handle. Identity/relay changes remain a private authorization-boundary teardown. Shadow input diagnostics remain local and bounded (100 entries/16 KiB), with no telemetry or pass payload.

A pass is an empty frozen object recognized by an owner-local WeakMap. Its route, canonical parameters, origin, principal, session, residency, and spend state remain local. Screen owners join an existing navigation generation; blur/background revoke it. Tap authority ends on synchronous handler return even when that handler returns a promise. A negotiated connection gets one bounded recovery batch per generation. Atomic spend produces only an operation name and immutable canonical input. It never sends a pass or reports held keys. Commands prepared before tap expiry remain immutable intent; session reset fences their later delivery.

`scripts/generate-network-codecs.mjs` derives structural codecs for all operation contracts. Unsupported TypeScript shapes or compiler errors fail generation; CI checks drift. `uploadMedia` is an explicit file-bytes exception at the existing documented HTTP site, validated separately with the 25 MiB file limit. Void replies are explicitly null on the wire, matching the dispatcher. JSON validation bounds bytes, depth, node count and union work, rejects accessors/cycles/nonfinite numbers and preserves forward-compatible DTO fields. These structural codecs do not replace semantic server authorization or per-family negotiated bounds.

`migration-sites.json` inventories existing transport boundaries and their retirement phases. Counts identify source boundaries, not a claim that each legacy consumer has an approved trigger. The additive scanner reuses the existing phone scanner's alias, dynamic-global, native and SDK checks, adds server/helper imports and Rust leaves, and checks private-core import boundaries. CI forbids additions and count growth against its trusted base. During initial inventory bootstrap, changed and new sources are compared to the base source so a new call cannot authorize itself by appearing in this inventory. The phone's `network-channels.json` remains its separate authoritative transport-exception gate and has shrunk by the removed Google favicon fallback.

## Proofs

- `npm test -w @beeline/net -- src/router-pass.test.ts`: local P1 state-machine and serialization proofs.
- `npm test -w @beeline/net -- src/read-lanes.test.ts`: coherent staging, bounded future batches, real navigation generations and shared demand.
- `npm test -w @beeline/net -- src/command-intents.test.ts`: immutable persistence, uncertain results, principal fencing and recovery budgets.
- `npm run typecheck -w @beeline/net`: operation exhaustiveness and negative type fixtures.
- `node --test scripts/router-boundaries.test.mjs`: P11 boundary, native, alias, SDK, and trusted-base bootstrap fixtures.
- `node scripts/check-router-boundaries.mjs --base <trusted-base>`: pure core, private imports, and migration non-growth.
- The phone-network and router-boundary checks also reject lifecycle capability escapes, including test-seam imports and raw server phone socket captures. SHARED PACKAGE TESTS executes the admission suite with a 4096 MiB heap cap and at most two workers.

## Remaining migration gates

See [the closure ledger](../../data/network-ops-fixes/closure-ledger.md) for whole-finding proof status. The server completion-wait slice closes F26; partial owners and disabled capabilities do not close other findings. All-route owner declarations, complete source/authority differential capture, remaining consumer families, native SDK traffic, runtime40/device evidence and the command rollback floor remain required. An owner calling `connected` alone is not proof of a real negotiated socket; that boundary is covered separately in the actual transport tests.

The static inventory detects known network entry points; arbitrary third-party package behavior still requires the specified native/SDK captures. Dependency classification and all operation-specific migration proofs remain launch gates. Do not treat a green inventory as permission to turn router-v1 on.
