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

The five-sample cost gate in `scripts/prove-router-group-c-room-payload.mjs` still fails strictly. Original failure: [eight candidate versus two legacy statements](group-c-room-cost.json). After repair: [two versus two](group-c-room-cost-after.json), SQL result bytes 2,586 versus 6,753,492 and wire bytes 2,733 versus 6,626,506. Local Node CPU observations improve, but are not a production PostgreSQL CPU/p95 enqueue/native paint acceptance proof. Shared coordinator ticket/fence work and all content-dependent decorators remain part of the full F13 workload obligation.

**Remaining failure:** the first candidate read emits 1,144 physical WAL bytes versus zero legacy bytes; subsequent four samples emit zero for both. The assertion is unchanged and exits nonzero. [Decoded WAL](group-c-room-cost-wal.txt) contains six `Heap2 PRUNE` records, transaction 0, relation filenode 66869. The captured `walRelations` maps that file to `live_streams`. This is physical heap pruning on reading the journal head after fixture writes, not an application INSERT/UPDATE. It is still charged to the candidate; no vacuum, warm-up, excluded first sample or relaxed WAL budget is used. No WAL/schema tuning is proposed without an equal-load writer/read proof.

Reproduce in an isolated loopback PostgreSQL database:

```sh
BEELINE_COMMAND_TEST_POSTGRES_URL=postgres://USER@127.0.0.1:PORT/postgres \
BEELINE_GROUP_C_COST_PROOF=1 \
node --import tsx scripts/prove-router-group-c-room-payload.mjs
```

## Exact native prerequisite for complete cohort closure

The authoritative spec §17 requires Android native40/current compatible OTA, native40/old OTA, Android44, iOS37, actual released newer runtimes when relevant, web/Tauri, old/new helpers and mixed servers. §11 requires real native SDK behavior. Current source declares iOS38 and Android47; source platform mocks cannot establish behavior of an installed older binary. This host is Linux, `xcrun` is unavailable, and the connected tool inventory provides no iOS device/simulator execution service. Android emulators exist; this is specifically an iOS execution/provenance gap, not a claim that Android testing is unavailable or that a physical phone is mandatory.

A macOS/iOS test host or device service with the supported iOS37 and relevant released newer install/OTA provenance, isolated test identity/server and native SDK/network capture is needed to execute these required journeys:

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

The legacy Room latency suite passes 17 cases and fails its unchanged 650 ms corner-open ceiling at 702 ms. A targeted recheck also fails at 1,021 ms (two queries, one mention enrichment, largest result one row); [retained output](group-c-room-latency-recheck.txt). This is a failing validation, not a performance pass or a proven pre-existing failure. No threshold or assertion changed.
