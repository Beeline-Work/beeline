# Network router closure ledger

No whole finding is closed until all consumers and the specified executable proofs pass. Capability-disabled infrastructure is staged implementation, not closure. The reviewed specification remains authoritative.

| Finding | Status | Required executable closure |
| --- | --- | --- |
| F01 offscreen overlays | Open | P12 helper A/phone B: zero viewers→zero text stream; entry one baseline; terminal/reset correct. |
| F02 global replay/refetch | Open | P5 affected list updates once on both servers; unrelated reads/queries0. |
| F03 Members/profile | Open | P3 1,000 draft/turn/presence frames→reads0; relevant membership exact fact. |
| F04 Needs-you work/seen | Open | P3 snapshot writes0/unaffected scans0, painted IDs only, count/cells same-cut. |
| F05 hidden schedule/workflow | Open | P2/P3 16 unmounted Rooms plus changes→reads0; return ≤1/key. |
| F06 full tray/global gaps | Open | P3 badge ≤1KiB; 10 Workspaces one change→other reads0/full tray0. |
| F07 payload/previews | Open | P8/P11 200 large tools absent initial DTO; excerpt bounds; view/save share flight. |
| F08 Workbench/wallet | Open | P3 connector change→wallet reads0; snapshot provider/queue0; exact cell update. |
| F09 portrait duplicate | Open | P2/P3 two consumers one commit→one update/no event read. |
| F10 foreground | Open | P4 healthy callbacks reads/replacements0; half-open one replacement/≤1/key. |
| F11 auth/OTA | Open | P9/P10 pending 10min timed reads0; repeated active no repeated update check. |
| F12 receipts | Open | P12 idle-progress10min turn deltas/noop writes0; owner death still fenced/expires. |
| F13 replay work | Open | P5/P6/P11 equal-load DB/WAL/CPU no regression; sockets do not multiply base reads. |
| F14 helper inbox | Open | P12 unrelated turn/activity getRoomInbox0; new command to correct agent once. |
| F15 MCP double poll | Open | P12 idle>25s/day empty calls0; inbox durable before cursor. |
| F16 minute repairs/checks | Open | P12 idle day provider/repair reads0; only due family runs, leader recovery works. |
| F17 sweeps/leases/voice | Open | P12 no-work scans0; session expires once; two owners fenced/no lost-double meter. |
| F18 backoff | Open | P4/P7 24h repeated failure→one attempt/boundary, flapping no loop. |
| F19 draft/context | Open | P12 N appends final L cost O(L+bounded reset); duplicate command context1; revoke blocks effect. |
| F20 account usage | Open | P12/P3 same account revision/two machines one update; profile/Workbench refetch0. |
| F21 payment/OAuth/share | Open | P7/P12 pending10min observations0; completion correct waiter; lost result UNKNOWN; renewal failure stops. |
| F22 hosting/cron/vendors | Open | P11/P12 classify every audit Appendix D1/D2 entry by exact route/due record/test; readyz DB probe0; no scheduler blanket exemption. |
| F23 files/link/favicon | Open | P8/P10/P11 preview→view→save one flight; expiry refresh only demand; Google favicon0/native bytes bounded. |
| F24 write refetch | Open | P7/P3 each send/reaction/delete/decision effect1/post-read0/correct other reader; legacy hints stay. |
| F25 hidden roster | Open | P3/P8 picker closed Workspace reads0; open ≤1 snapshot; grants current server authority. |
| F26 wait polls | Closed: committed completion capture, 85-second no-poll and existing connector/MCP integration proofs pass | P7/P12 completion before/during listen never lost; pending85s one initial read/no repeats; duplicate effect1. |

## Validated staged infrastructure

- F04 live projection read-purity regression shipped separately; same-cut count/cells and source coverage remain required.
- Local admission, structural codecs, boundary scanners and shadow diagnostics have focused passing proofs.
- Socket transport has 77 passing regressions including lazy recovery and negotiation; native/cohort matrices and complete family migration remain open.
- Projection integration has ten passing cases covering pure snapshots, certificate revocation, independent drains and retention parking.
- Durable command ledger has 14 passing cases; committed completion capture has three. A real PostgreSQL two-pool contention proof passes.
- Existing socket dispatcher compatibility has 15 passing integration cases. Connector compatibility: 133 passed, one pre-existing skip; MCP compatibility: 140 passed. Current-authority command replay: six passing cases.

These counts identify the staged validation run; later changes must rerun affected suites before a PR claims the result.

- F03/F05/F09 staged compatibility fixes filter transient roster events, release hidden schedule/workflow/profile observers, and make portraits consume parent detail. Focused suites pass; complete negotiated roster/workflow facts and cross-consumer closure remain open.
- F11 staged auth/update migration uses held completion over committed ticket notifications, one event-driven recovery boundary and one shared SDK owner. Native-runtime40 SDK-internal launch behavior and the released native/browser matrix remain required before closure.

- F13/F16/F17/F22 staged server changes add bounded journal retention, canonical projection suppression, actual due-record scheduling and idle voice/readiness proofs. Full presence (29), projection (12) and real PostgreSQL retention (2) passed; follow-up aggregate lease ownership (3) and actual phone viewing (9) regressions also pass. Findings remain open.

- F14/F18 staged Body migration removes retry clocks from command acquisition, Room bootstrap, MCP reads and failed helper startup. Tests cover parked failures, one incident replacement, source-revision recovery and existing isolated update drains. Remaining recurring providers/ownership proof and all released cohorts remain open.

- F15 staged member stream passes24-hour idle/committed-source, persisted-delivery-before-cursor, HTTP capability/listener gating and real PostgreSQL revocation contention proofs. Existing MCP140 and join8 compatibility cases pass. Autonomous activation requires the server capability; old Body polling remains open.

- F07/F23 staged media work uses closed viewport/action admission, socket metadata, shared immutable flights and bounded native/web stores. Old-server recovery and disconnect downgrade protection are tested; authority-only frames purge bytes without inventing a data cut. Server read-family activation remains gated on precise aggregate cache purge; runtime40 latency/physical cache and external sandbox traffic proofs remain open.

- F10 follow-up: one application health challenge on resume/path edges, no reads on success, and one incident replacement on failure. LiveConnection82 and the real server ping/no-database test pass. The recovery latch conservatively waits for a distinct external/user boundary; complete lane and cohort workloads remain open.
- F07/F23 native evidence: [historical runtime40 probes](../../apps/mobile/evidence/network-router-native40/README.md) pass scoped containment, native file restoration, cache/download bounds and actual browser visibility/foreground transitions. The 25 MiB base64 path measured a multi-second frame stall; performance, real authority integration and other cohorts remain open. This is the authorized historical APK with synthetic candidate JS, not the Play binary or a production OTA claim.
- F17/F21 computer-share follow-up: source-driven committed expiry, exact renewal fence and explicit failed-page Retry pass share6/expiry3/computer25. No upstream expiry probe or failed-renewal timer remains. OAuth/payment and other voice/ownership obligations remain open.

- Scoped equal-workload badge probe: `router-badge-workload.integration.test.ts` uses actual 16-Room/256-ask data, interleaved cold reads and 100 focus journeys through the real lane owner. It exposed and fixed immediate-LIVE-release cache reuse; repeated focus now executes one candidate read versus 100 legacy reads. [Measured results](badge-workload.json) retain the original five-versus-one cold statement regression and its specialized pure-SELECT fix: both paths now use one statement, with a 796-byte candidate envelope under the 1 KiB cap. Count, current certificate and stream head share one statement snapshot; same-cut/authority/501st-question overflow tests pass. Local timings are not production CPU/p95 enqueue or native paint proof; whole-router non-regression remains OPEN.

- F07/F23 typed-byte follow-up: [two historical runtime40 launches](../../apps/mobile/evidence/network-router-native40/typed-io/README.md) use the existing native file and crypto ABI. The final store14/digest7/cache11/owner7 suites pass. Warm 25 MiB storage takes397–423ms with20.98–21.25ms maximum frame gaps, versus the previous multi-second stalls; cold startup still reaches108–115ms. SHA256 takes61.88–71.11ms versus38,194.9ms for the measured synchronous legacy hash. Native file, hash and UI integration were not measured as one full-screen flow; physical phones, real authority integration and other cohorts remain open.

- F02/F10/F13 Room continuity staging derives current/former Room audience from DB authority and committed source relationships, subscribes before baseline, and classifies inactive intervals without held-key inventory. Continuity11/real PostgreSQL1, core groups8/lanes34 and mobile owner16/socket85 pass. Missing negotiation still parks with explicit Retry. [Local fanout measurement](room-audience-workload.json) shows one audience query and zero DTO builds for unrelated changes, but10821/80728 bytes for16/128 Rooms; compression and full-source/equal-workload gates remain open and capability stays disabled.
- The Room continuity slice also preserves existing group4/projection12/shared-socket3 and Postgres fanout38 regressions, with mobile typecheck passing. Canonical JSONB object-key normalization is tested against the final authority reader; no fence was relaxed. The old plain-badge sharing test now counts its two actual scalar snapshot queries instead of the superseded generic-builder callback.

- F16/F17 choice expiry follow-up: exact committed source and stored minimum replace the minute discovery/five-second rate gate; batches cap100 and compare the captured PostgreSQL timestamp under row lock. Source rollback/content-only suppression, idle day, failure parking, microsecond replacement and existing HTTP expiry pass (4+1). Background leader ownership and other due families remain open.

- F17 voice follow-up: commit-before-forward PCM admission, final current-owner enqueue fence, bounded one-second/32kB ownership transfer, failure parking, source-scoped participant snapshots and exact120-second absence deadlines pass budget21/runtime264/service30/realPostgreSQL2/live39. Server typechecking passes. Accounting can charge admitted audio lost before external STT delivery; external exactly-once delivery is not claimed. Physical voice and remaining ownership/job families keep F17 open.

- F12 staged ownership (D046) binds each claimed generation immutably to the real helper connection/epoch. Old rows and recorded legacy claims retain freshness receipts. Selected turns use the existing aggregate server lease and machine heartbeat; the ten-minute actual-socket proof observes no per-turn freshness writes or per-agent empty checkpoints. Owner loss uses existing exact-generation silence/requeue transitions. The protocol capability remains independently negotiated under the one disabled router setting; server rollback must preserve owned-row and immutable-generation meaning.
- F12 current-effect proofs pass ownership5/actual socket3/real PostgreSQL1, owned deadlock no-retry1, and actual effect/final enqueue/two-pool authority1. They cover late generation/source rejection, commit-time lease expiry rolling back admitted message/progress writes, current Room/Workspace denial, replacement serialization, actual failed-corner-receipt lifecycle ordering, and a nonempty common close command lock whose archival transaction rolls back. Account-deletion16 passes, including refusal of an expanded lock scope before erasure. The close contention proof deliberately stops at rollback before later stop-delivery business work. Terminal-requeue confirmation2, selected legacy corner18 and GitHub12 pass; those are selected regressions, not complete corner/GitHub suite runs. Terminal confirmation requires the exact immutable old source binding, failed turn and cleared pending row; it makes no new claim and refuses expired, foreign or newly claimed generations. Strict overlay7/real PostgreSQL1 also pass. New owned paths refuse unsupported external/model effects; full provider adapters, command-bound model transport, per-effect WAL/equal-workload budgets and released cohorts keep F12 OPEN.
- F14/F18 recovery follow-up passes initial-data unit6/actual socket3, daemon client23/helper-turn6/refusal6. Registration/subscription/intake control frames cannot certify or renew a pending initial barrier. One existing control deadline ends the agent owner; repeated initial failure cannot reset the incident replacement budget, and 24-hour synthetic transport controls admit no new observation/retry. New command-only subscriptions negotiate no inbox; old servers still require an actual legacy empty inbox snapshot. Ephemeral request IDs and immediate unsubscribe cancellation prevent an old awaited read from completing or evicting a newer subscription. Complete F14/F18 source/cohort workload closure remains OPEN.

- Current-main integration (exact main `04d522b494f506cd8732d22f2ae2099785d17a04`): model credential19/attempt13/PostgreSQL11/endpoint13, background8, presence30, voice-budget21, choice-expiry4, turn-notices50 and account-deletion18 pass. Full typecheck, dead-code (5 existing/0 introduced), architecture17, network72, router boundary and owner bundle gates pass. The shared notifier leaf remains the one dependency-free connection publication owner; test-only model seeds now live in the canonical test-fixtures directory. Main's retired reviewer behavior remains retired. This integration closes no additional finding and selects no new protocol.

- Current-main integration `3fe0d1b17ef0f73a6e6948b117ba7130e736a209`: derived corner idle episodes replace retired attention state; the new idle query retains current owned-command checks. Attention87/commander209 and entrypoint13 pass. Helper38 passed before repairing its old control-only reconnect fixture; both push/reconnect cases pass with actual initial command+inbox snapshots. Full typecheck, dead-code and architecture/network/router/workflow/codec scans pass; no activation or additional finding closure.

- Unselected model/readiness integration: bounded first/resumed source traversal and actual owner-end socket acknowledgements are now implemented. Missing/corrupt private model journals end owner authority without rewriting provider outcomes. See [model proof](owned-model-proof.md) and [clock ownership](background-clock-ownership.md). Installation, cross-server reader health, UI/automatic-idle behavior and full cost/rollout gates remain OPEN; only F26 is closed.

- F04/F05/F06/F13/F24 staged Tray/Saved/Scheduled Work integration is now committed. Saved head arrivals share the canonical bounded head while historical windows keep exact-row semantics; 100 arrivals cause no history reads. The explicit continuation button can bridge a shifted-head gap. See [Saved proof](tray-saved-proof.md) and decisions D052–D063. The phone bundle blocker is resolved by owner instruction034, with hard90112raw/24576gzip limits; this does not close workload, installed-cohort, production-composition or all-consumer gates.


- F16/F18 staged leader integration selects the single blocking advisory-lock owner in `index.ts`, removes the old try-lock/health-query loop, and makes dedicated pool checkout one attempt. Leader12, real PostgreSQL2 (including polling-old/blocking-new overlap), shutdown6, Needs expiry9, scheduling8, background40 and dedicated checkout2 pass. Remaining periodic job/provider/source composition and general query retries remain open. No whole finding changes status.


- F18 SQL admission now removes generic query/BEGIN and boot-schema retry clocks. A lost INSERT reply reproduced two effects before removal. Database59 pass across full57 + corrected legacy-fixture2; actual PostgreSQL2 proves one effect despite lost INSERT/COMMIT replies; background recovery4, operator delivery9 and server91 pass. The new PostgreSQL proof and mixed-leader proof run in the isolated CI lane. Higher-level and SDK retry/removal coverage remains open.


- F18 release/GitHub SQL contention no longer self-retries. `migration-steps.test.ts` passes10, including two real PostgreSQL lock/diagnostic cases and idle-day no-attempt checks. Focused GitHub31 pass across26 + corrected event-read-count5, covering installation/check/confirmed-merge reconciliation, transaction rollback, head/fetch fences and one wake per committed result. CI and timing references follow the renamed single-attempt helper. Provider retries and periodic GitHub discovery remain open.


- F18 GitHub check transport removes the shared retry executor from rollup, installation-token and PR reads. Shared-client104 and server integration18 pass, including 24h no reattempt, retained Retry-After, current-head/permission refusals and shutdown. Auth/emulator and server types plus router/tree guards pass. Queued-check discovery and other recurring provider work remain open.

- F16/F18 startup mergeability repair now consumes one admission per leader epoch even on failure. Shutdown7 passes, including 24 hours of unrelated minute cycles with one failed provider attempt and exactly one new attempt on takeover. Periodic pending/queued/merge discovery and the complete router-only sweep remain open.

- F16/F18/F22 check discovery removes the queued-refresh/pending-head minute scans and their provider executors. Failed reads keep the current gate pending without writing retry obligations; a later event or explicit check command supplies new admission. Focused GitHub38 and pending-check6 pass, including real error classification, idle-day no retry, restart, obsolete-head suppression, transaction/head/fetch fences and reviewer dispatch. Server types, router boundaries and architecture guards pass. Recurring merge/reviewer discovery and whole findings remain open.

- F16/F22 merged/closed PR discovery removes the unaddressed provider sweep and its minute registration. Exact-corner explicit checks and actual webhooks retain idempotent reconciliation. Check-gate54, focused lifecycle8 plus strengthened unchanged-verdict1, and missed-merge1 pass; server types and router boundaries pass. Locked corners, queue clearing, archival/branch cleanup and no extra merge dispatch remain covered. Reviewer and other recurring discovery remain open.

- F18 LISTEN acquisition removes the one-second retry loop and its test-only delay option. Listener41 and focused recovery5 pass, including 24-hour idle failure, duplicate disconnect, one replacement, real recovery, late initialization/socket fencing and missed committed data on feed restoration. Server typecheck and phone/router scanners pass. Notifications received on the current connection during initialization remain valid; only retired connections are fenced. No whole finding changes status.

- F18 save-time embeddings remove the per-row retry timers/map and retry policy export. Embedding36 passes, including an idle day after refusal/throw, one fresh attempt on an actual edited save, existing version fences and no read while disabled. Full workspace build passes. Startup backfill and final durable route ownership remain open.
