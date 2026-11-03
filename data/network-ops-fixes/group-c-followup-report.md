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

## Deferred rollout capture gate

Firstmate instruction 007 explicitly defers iOS native captures to rollout and authorizes this PR to become ready with the F13 fixes and local proofs. Do not free space or delete anything on the supplied Mac: it is the captain's machine. The earlier capacity blocker is resolved by that deferral, not by native execution. No further Mac action is part of this delivery. [Preflight observations](group-c-ios-host-preflight.json) are retained; no dependencies were installed, no simulator was created, no application was built and no existing workspace was accessed.

The authoritative spec §17 matrix remains a rollout gate: Android native40/current compatible OTA, native40/old OTA, Android44, iOS37, actual released newer runtimes when relevant, web/Tauri, old/new helpers and same-version/mixed servers. Current source declares iOS38 and Android47. Source platform mocks do not establish installed SDK behavior. Instruction 006 approves exact built source SHA as native-build provenance; retain the actual tested source/runtime combination and identify any unsupported or substituted cohort explicitly.

Before cohort acceptance, execute and retain the following captures against an isolated test identity and real PostgreSQL server, using an adequately provisioned native execution host. This list is deferred work, not a record of passed captures:

| Finding | Exact rollout capture |
| --- | --- |
| F07 | Open a Room with 200 tools each carrying 32 KiB output. Capture initial DTO/full-tool-row count, wire bytes and native parse/render/paint; disclose, paginate and open full output through the actual UI. Assert zero initial full rows, a <=64 KiB Room envelope, <=50 rows/64 KiB per expansion page, bounded excerpts/previews, and all 200 unique source IDs recoverable. |
| F10 | Capture actual native AppState/path callbacks and socket/read counters: 100 duplicate healthy active callbacks cause zero replacements/reads; a half-open incident permits one replacement and <=1 snapshot per still-demanded key. Hidden keys read zero; background immediately fences screen reads. |
| F11 | Capture native Expo SDK traffic at cold pre-socket launch and repeated resume, including SDK-internal requests. Verify the private one-shot/shared-epoch automatic check and explicit Settings sharing. Exercise both GitHub and Google warm/cold callbacks, lost callback/reply and durable correlation. Pending ten minutes must produce zero timed status reads; duplicate active callbacks must not check again. |
| F13 | On the same workload and cohort, compare candidate/legacy server statements, physical WAL, journal bytes, projection CPU and p95 enqueue, plus native parse/render/paint. Include shared coordinator/ticket/current-fence work and content-dependent decorators, multiple sockets on two servers, and unrelated readers/scopes. No metric may regress; unrelated work must remain zero. The passing local cold Room gate is not a substitute for this full acceptance capture. |
| F18 | Drive real native path/resume flapping and a failed replacement/refused attempt. Capture SDK/adapter attempts across the 24-hour parked interval: one attempt per distinct authorized boundary, no timer or brief-open reset loop. Explicit Retry admits one attempt; a lost committed command result stays UNKNOWN and reuses its identity. |
| F21 | Capture actual native sign-in/payment/OAuth/ceremony and share/session owners for pending ten minutes, unrelated completion, committed completion, rollback, lost reply/cold recovery, expiry and failed renewal. Assert zero timed status observations, only the correct waiter wakes, no resubmission of an uncertain effect, and no renewal loop after failure. |
| F23 | Capture actual native preview -> view -> share/save metadata and byte flights, immutable disk restore/digest, expiry while idle, explicit demand after expiry, disconnect/revoke/logout and purge. Assert one shared metadata/byte flight, zero time-only refresh, <=16 KiB preview, <=25 MiB object, <=128 MiB disk and <=4 downloads; Google favicon requests remain zero. Exercise each existing native/view/save consumer. |

Each capture must retain source SHA, native binary/bundle hashes, app runtime and SDK versions, launch/fallback result, negotiated capabilities and selected path, server image/schema identity, device/OS/WebView identity, journey inputs, exact counter/byte/latency observations and assertions. Preserve failure evidence and identify missing cohorts rather than extrapolating from a supported subset. Where a native build is substituted for a released artifact under instruction 006, label that provenance explicitly.

No whole finding is Closed by this deferral. F07/F10/F11/F13/F18/F21/F23 remain Open for complete consumer/cohort acceptance; the integrator owns the live ledger. The router stays capability-off. No native lifecycle, release, minimum-version decision or production access was attempted.

## Additional validation

Server typecheck passes. Projection integration: 26 passed. CI workflow tests: 20 passed; 133 workflow path references resolve. The strict F07 payload/expansion proof still passes.

The unchanged legacy Room suite now passes all 18 cases. The corner-open duration is **475 ms < 650 ms**; concurrent corner opens retain eight statements for four consumers. [Passing output](group-c-room-latency-fixed.txt). Source changes make each Room message window LATERAL and bounded before identity/reaction decoration, preserve the rounded-second activity bound while allowing the timestamp index, and avoid mention resolution only when text contains no `@`. The full tokenizer/ambiguity rules still run for every possible mention.

Retained history: 702 ms initial failure and 1,021 ms targeted failure ([output](group-c-room-latency-recheck.txt)). A profile of the existing fixture found 10,182 identity lookups before a window limit and 1,200 tag/identity checks, approximately 88 ms, mostly for text without `@`. No timing threshold, assertion, fixture or proof changed.
