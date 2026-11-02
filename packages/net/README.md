# Beeline network admission

This is the M0/T1 foundation for the network router. It does **not** change production traffic or enable router-v1. All 334 phone and daemon operation leaves are explicitly `legacy-only`; the compiler requires the inventory to match both operation maps. No public executor, URL fetcher, pass factory, or recovery factory exists.

`src/private/admission.ts` is a transport-free shadow state machine for the initial Room read, AppShell count, and SendMessage policies. Trusted owner integration comes in the negotiated migration slices. The scanner currently rejects every production import of that private machinery, including reexports through another package. The public package exposes the immutable operation inventory with input/result codecs and erased types only.

A pass is an empty frozen object recognized by an owner-local WeakMap. Its route, canonical parameters, origin, principal, session, residency, and spend state remain local. Screen owners join an existing navigation generation; blur/background revoke it. Tap authority ends on synchronous handler return even when that handler returns a promise. A negotiated connection gets one bounded recovery batch per generation. Atomic spend produces only an operation name and immutable canonical input. It never sends a pass or reports held keys. Commands prepared before tap expiry remain immutable intent; session reset fences their later delivery.

`scripts/generate-network-codecs.mjs` derives structural codecs for all operation contracts. Unsupported TypeScript shapes or compiler errors fail generation; CI checks drift. `uploadMedia` is an explicit file-bytes exception at the existing documented HTTP site, validated separately with the 25 MiB file limit. Void replies are explicitly null on the wire, matching the dispatcher. JSON validation bounds bytes, depth, node count and union work, rejects accessors/cycles/nonfinite numbers and preserves forward-compatible DTO fields. These structural codecs do not replace semantic server authorization or per-family negotiated bounds.

`migration-sites.json` inventories existing transport boundaries and their retirement phases. Counts identify source boundaries, not a claim that each legacy consumer has an approved trigger. The additive scanner reuses the existing phone scanner's alias, dynamic-global, native and SDK checks, adds server/helper imports and Rust leaves, and checks private-core import boundaries. CI forbids additions and count growth against its trusted base. During initial inventory bootstrap, changed and new sources are compared to the base source so a new call cannot authorize itself by appearing in this inventory. The phone's `network-channels.json` remains its separate authoritative transport-exception gate and is unchanged.

## Proofs

- `npm test -w @beeline/net -- src/router-pass.test.ts`: local P1 state-machine and serialization proofs.
- `npm run typecheck -w @beeline/net`: operation exhaustiveness and negative type fixtures.
- `node --test scripts/router-boundaries.test.mjs`: P11 boundary, native, alias, SDK, and trusted-base bootstrap fixtures.
- `node scripts/check-router-boundaries.mjs --base <trusted-base>`: pure core, private imports, and migration non-growth.
- Existing `scripts/check-phone-network-channels.mjs` and its tests continue unchanged in TYPECHECK. SHARED PACKAGE TESTS executes the admission suite with a 4096 MiB heap cap and at most two workers.

## Remaining migration gates

This foundation closes no complete F01–F26 audit finding. Production navigation/accessibility ownership, all-route trigger/source declarations and semantic codec refinements, private platform adapters, lane integration, command persistence, negotiated server snapshots/pushes, timer removal, runtime40 and native SDK capture remain required. The shadow policies are not a substitute for those proofs. In particular, an owner calling `connected` is not itself proof of a real negotiated connection: that boundary must be proved at the actual socket adapter before opt-in. User-request deadline recovery is lazy: one replacement and one focused catch-up, never a heartbeat timer.

The static inventory detects known network entry points; arbitrary third-party package behavior still requires the specified native/SDK captures. Dependency classification and all operation-specific migration proofs remain launch gates. Do not treat a green inventory as permission to turn router-v1 on.
