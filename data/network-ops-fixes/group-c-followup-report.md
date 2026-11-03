# Group C follow-up: Room cost and native proof gate

This follow-up addresses firstmate instruction 005 after the initial group C changes were integrated. Router capability remains disabled. No whole finding is Closed; the integrator owns the live ledger.

## F13 implementation repair

The authorized Room SELECT now also returns the canonical workspace stream head, required authority epochs, bounded tool summaries and the existing enrichment. The returned Room, authority and cut share one PostgreSQL statement snapshot in the existing read-only transaction. Missing epochs/stream heads fail closed; reads do not initialize them. The separate READ COMMITTED shared-lock enqueue fence remains in place.

`apps/server/src/room-router-read.postgres.test.ts` exercises actual production SQL on real PostgreSQL:

- The optimized snapshot equals the generic same-cut snapshot, with precisely SET isolation plus one SELECT; wrong Workspace/unrelated reader fail.
- Root and corner prose, bookmarks, reports and attachment expiry match legacy reads with two statements.
- A writer committing after the SELECT cannot relabel the fetched Room with the new cut.
- Current enqueue still holds the shared authority lock; revoke blocks during enqueue and rejects the stale certificate afterwards.
- Missing authority and missing stream refuse without inventing state.

The five-sample cost gate in `scripts/prove-router-group-c-room-payload.mjs` now passes unchanged, including the first cold read: **two candidate/two legacy statements, zero candidate/zero legacy WAL bytes** in every sample. SQL result bytes are 2,586 versus 6,753,492 and wire bytes 2,733 versus 6,626,506. [Passing observations](group-c-room-cost-fixed.json) also retain local Node CPU/time, without claiming production PostgreSQL CPU, p95 enqueue or native paint acceptance. Shared coordinator ticket/fence work and content-dependent decorators remain part of the full F13 workload obligation.

Retained history: [eight candidate versus two legacy statements](group-c-room-cost.json), then [two versus two with 1,144 cold WAL bytes](group-c-room-cost-after.json). [Decoded WAL](group-c-room-cost-wal.txt) maps six `Heap2 PRUNE` records to `live_streams`. The equality lookup visited obsolete versions of the hot journal head. Equal closed bounds plus descending order preserve a backward path through the existing primary key, reaching the current head without that historical-page pruning. [EXPLAIN](group-c-head-plan.json) confirms one row, two shared buffer hits, no dirtied blocks and no WAL. There is no new index, writer change, vacuum, warm-up, excluded first sample or relaxed budget. The cost mode now runs in the existing serial PostgreSQL CI lane.

Reproduce in an isolated loopback PostgreSQL database:

```sh
BEELINE_COMMAND_TEST_POSTGRES_URL=postgres://USER@127.0.0.1:PORT/postgres \
BEELINE_GROUP_C_COST_PROOF=1 \
node --import tsx scripts/prove-router-group-c-room-payload.mjs
```

## Native execution for complete cohort closure

The authoritative spec §17 requires Android native40/current compatible OTA, native40/old OTA, Android44, iOS37, actual released newer runtimes when relevant, web/Tauri, old/new helpers and mixed servers. §11 requires real native SDK behavior. Current source declares iOS38 and Android47; source platform mocks cannot establish behavior of an installed older binary. Firstmate instruction 006 supplies an authorized x86 macOS host over SSH and directs building the released-runtime iOS app there; the exact built source SHA is the approved provenance. The earlier host blocker is resolved; the strict F13 Room cost and latency assertions now pass and native captures are next. Android emulators exist; this is specifically an iOS execution/provenance gap, not a claim that Android testing is unavailable or that a physical phone is mandatory.

The supplied Mac will be used with isolated task source/runtime state and native SDK/network capture for these required journeys:

| Finding | Native journey still required |
| --- | --- |
| F07 | Initial 200-tool Room parse/render/bytes and actual disclosure/output; no large full rows before expansion, with bounded preview. |
| F10 | Real native AppState/path callbacks on a healthy socket, half-open challenge/replacement, demanded-key reconciliation and background fencing. |
| F11 | Actual installed Expo update SDK cold pre-socket launch and repeated resume, plus warm/cold GitHub and Google callback correlation; capture internal SDK checks. |
| F18 | Native path/resume flapping and failure over the parked interval; confirm actual SDK/adapters do not schedule another observation/connection. |
| F21 | Warm/cold correlated native sign-in/ceremony callback after held completion/lost reply and share/session expiry/failed renewal through the actual owner. |
| F23 | Actual native file preview/view/share/save, immutable disk cache/digest, revoke/logout purge, 16 KiB/25 MiB/128 MiB/four-download bounds and demand-only expired capability refresh. |

These are exact required native gates, not new scope or permission requirements. The prior PostgreSQL/real WebSocket/source-owner proofs remain useful but do not substitute for native SDK execution. Other unproved consumer/platform journeys are not silently marked passed. No finding is closed on the strength of a supported subset; no native lifecycle, release, minimum-version decision or production access was attempted.

## Additional validation

Server typecheck passes. Projection integration: 26 passed. CI workflow tests: 20 passed; 133 workflow path references resolve. The strict F07 payload/expansion proof still passes.

The unchanged legacy Room suite now passes all 18 cases. The corner-open duration is **475 ms < 650 ms**; concurrent corner opens retain eight statements for four consumers. [Passing output](group-c-room-latency-fixed.txt). Source changes make each Room message window LATERAL and bounded before identity/reaction decoration, preserve the rounded-second activity bound while allowing the timestamp index, and avoid mention resolution only when text contains no `@`. The full tokenizer/ambiguity rules still run for every possible mention.

Retained history: 702 ms initial failure and 1,021 ms targeted failure ([output](group-c-room-latency-recheck.txt)). A profile of the existing fixture found 10,182 identity lookups before a window limit and 1,200 tag/identity checks, approximately 88 ms, mostly for text without `@`. No timing threshold, assertion, fixture or proof changed.
