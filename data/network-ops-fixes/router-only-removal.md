# Router-only removal plan and current boundary inventory

Firstmate 029 removal order: unified router switch, then removal PR, then an empty bypass sweep across phone, helper, server, auth, shared packages and native/generated adapters. No additional compatibility switches, Settings paths, generic executors or migration exceptions count as completion.

The initial inventory is a read-only source audit of root worktree HEAD `48247e8b0b0a7dc494c9ddf38b6609eb3cbe479f`, including existing working-tree changes, on 2026-11-02. Root is concurrently collapsing the rollout flags; repeat extraction on the exact removal head. No combined-worktree changes, builds, tests, production reads, owner-state inspection, lifecycle actions or provider effects were performed. A subsequently authorized narrow object-storage correction is tracked below with passing local regression proofs; the remaining inventory is still a plan.

## Current verdict

The removal sweep is **not empty**. Read-only execution of the existing TypeScript/native boundary extractors found 158 router inventory keys and 218 source occurrences, exactly matching `packages/net/migration-sites.json`, with zero structural errors or inventory-count mismatches. Those are boundary references/imports, not 218 measured requests: some imports only validate IPs, configure address-family defaults, open local IPC, or appear in fixture/generated code. They must be resolved explicitly rather than renamed away.

The original phone manifest contains 54 keys/70 occurrences, including origin strings and links. It is a separate ratchet, not a declaration that every exception has router admission. The appendix preserves each exact site and its current fate. A clean inventory gate currently means “all debt is listed,” not “all networking is router-owned.”

`packages/net/src/routes.ts` still constructs the exhaustive phone and daemon contracts with `compatibility:'legacy-only'`. There is no complete runtime route owner/admission implementation for every declared operation. `monolithPhoneOperation` and `MonolithRoomViewClient` still issue generic main-socket requests, and most `DaemonApiClient.execute` operations still issue HTTP. Moving a call to the main socket, adding codecs or renaming a wrapper does not close that bypass.

## Final architecture and compatibility boundary

1. One transport-free shared route registry owns literal operation identity, exact codecs, permitted trigger/owner, scope/key, recovery policy, input/result/queue bounds, durable effect classification and source/deadline dependencies. No arbitrary URL, operation name, request object, provider client or executor is available to feature code. A caller can select only a closed leaf it is authorized to admit.
2. Existing phone live connection remains the sole phone data/control connection. Existing machine connection owns helper data/control. MCP member stream remains the declared external-member adapter. Physical HTTP/WebRTC/native/provider/database connections remain only as exact private route adapters with bounded ownership; “one router” does not force media, preauth, database or third-party browser bytes through JSON WebSocket frames.
3. Unified router selection is session-level and server-first. Once selected, a missing family/codec/source/effect proof fails closed in that owner; no feature retries through legacy HTTP, old getters, another socket, Settings, a timer or a second route. Remove the per-family/client fallback branches after their consumers migrate. Do not replace five flags with five hidden environment/settings escapes.
4. Native runtime 40 with compatible JS must run the same router and existing native APIs; no new binary requirement is justified by this work. Old installed JS/helper wire remains accepted at **one router-owned compatibility ingress**: authenticate, parse the old exact frame/endpoint, derive trusted principal/source, map to the same declared operation, enforce current authority and bounds, then dispatch once through its adapter. Keep no second implementation behind that ingress. New JS does not send pass IDs, held-key/cache inventory or navigation metadata.
5. Old-client command wire without a durable command ID cannot retroactively provide cross-retry command identity. Preserve the legacy operation's proven semantics at that ingress and record the exact cohort limitation; never invent a fresh ID on every receipt attempt and claim deduplication. Prepared message IDs can be reused only where the actual original immutable identity is proven. Router-only ownership and all-cohort exactly-once claims are different obligations.
6. Old server/new JS rollout needs a declared session protocol floor and ledger-preserving rollback floor before the removal build is delivered. Unsupported old-server sessions use the existing supported-update/refusal path; they do not silently run a parallel feature implementation. This is a deployment compatibility proof, not a new Settings preference or an assumption that installed old clients disappear. Preserve old wire ingress until a separately authorized supported-version floor removes it.
7. Permanent physical transport declarations are closed router adapters, not entries laundering migration debt. For each preserved source leaf, prove the exact owner and permitted route set, reject all other importers/URLs/operations, then remove its `legacy-only` debt entry. Do not simply delete inventory rows, add an entry, broaden a caller allowlist or exempt a directory to make the checker green.

## Dependency and delivery order

| Step | Concrete change | Exit proof |
| --- | --- | --- |
| 0. Freeze switch contract | Root's unified session switch; exact negotiated route/family/source/effect support and ledger schema/protocol rollback token. Inventory current callers before deletion. | Old/new phone JS and helper × old/new server matrix, runtime40/current OTA/web/Tauri, same-version and mixed-server failover. No selected session downgrades. |
| 1. Complete route ownership | Replace blanket `LegacyRoute` declaration with exhaustive owned leaves; implement read, command, private control/deadline, exception and server-provider policies. Finish actual T5 consumers and the four Tray decisions; see `tray-decision-plan.md` scratch audit. | Adding a contract operation fails types/registry coverage until its real owner, adapter, codecs and proof exist. Unknown route/source is denied before network/DB/provider entry. |
| 2. Move phone feature callers | Migrate `monolithPhoneOperation`, RoomView/rig/source getter consumers to exact gesture/focus/subscription/command owners; remove feature imports of raw `LiveConnection.request`. Route visible query/history/detail reads explicitly rather than declaring them unused. | Real navigation/read/action scenarios with zero unrelated work; healthy resume zero reads; focus miss ≤1/key; durable action ≤1 effect and zero post-write read; 24h settled idle zero observations. |
| 3. Move helper callers | Route ordinary `DaemonApiClient.execute`, read-only MCP facades, attachment/upload metadata, bootstrap/model/resource operations through machine/command owners; keep exactly one intake source/recovery owner and acknowledged initial barrier. | Real socket integration, malformed route codecs, immutable source/generation, revoked/expired owner, HTTP refusal for selected ops, zero fetch for selected machine commands, one recovery per actual boundary. |
| 4. Enclose physical adapters | Bind existing preauth/auth, file bytes, voice/browser, updates/push/telemetry, server provider, database and local control leaves to the registry. Address SDK/generated/subprocess/native paths below; eliminate generic exports. | Per-item proofs below plus dependency/native capture; no SDK retry, idle flush, background prefetch or provider re-entry hidden beneath an owned wrapper. |
| 5. Unify server ingress | Every legacy HTTP/socket/MCP path calls the same authorized declared operation adapter; webhooks and DB committed/deadline owners have explicit private routes. No endpoint directly calls an unregistered service method. | Actual HTTP+socket+MCP same-effect tests; all-path authority and rollback; exact legacy wire results preserved; selected forbidden HTTP effects refused before application/provider reads. |
| 6. Removal PR | Delete unused generic client exports/fallbacks/feature compatibility branches, old read/refetch reducers, retry loops, obsolete flags/settings and dead implementations. Preserve supported wire only in the ingress adapters above. Ratchet debt to zero; keep physical declarations exact. | Trusted-base AST/import graph/native/subprocess sweep, dead-code/types, adversarial mutations, exact head compatibility and equal-workload evidence. A passed name search alone is insufficient. |
| 7. Empty sweep | Re-extract all sources/dependencies/bundles/native views, compare every live boundary to its declared private adapter and every contract leaf to a runtime owner. | No undeclared/bypass edge and no migration-only compatibility entry. Published supported cohort evidence; unresolved SDK or unsupported action means not done. |

## Per-item correction and executable proof catalogue

Every appendix row is bound to one or more IDs below. The inherited fix and proof are mandatory for that exact site; grouping does not authorize an entire directory or arbitrary new requests. Paths and lines are extraction-time locations and must be refreshed after edits.

| ID | Sites / actual role | Required correction | Executable proof to author/run centrally |
| --- | --- | --- | --- |
| R01 | `server.ts`, `phone-socket.ts`, `daemon-live.ts`, `rooms-mcp.ts`; HTTP/WS/MCP ingress | Keep one owned authenticated dispatch path for each declared leaf; translate exact legacy wire at ingress, not in feature callers. Keep request deadlines, capacity, current-authority/epoch and final enqueue fences. Register public/admin/webhook routes as separate exact ingress leaves. | Actual HTTP/socket/MCP delivery, malformed/unknown route/input/result, old wire + runtime40, same effect replay, revocation before final enqueue, two-server contention, selected HTTP denial before application reads. |
| R02 | Phone generic `monolith-operation.ts`, `room-view-client.ts`, rig/source/store callers; `LiveConnection.request` | Complete literal route owners for ALL remaining screens, Settings, Wallet/Workbench/authenticated detail/search/history/actions; move network execution behind private admission and delete the generic feature executor/export. Existing selected Room/list/count/Tray/schedule/media/usage owners are foundations, not whole-contract coverage. | Enumerate every contract operation and actual caller; real existing action tests and focus/residency tests; no post-write load/list/read; no retained hidden screen reads; fake24h after denied/parked action zero network. Wrong pass/key/principal/URL/type tests. |
| R03 | `daemon-api-client.ts`, `read-only-mcp.ts`, resource facade, bootstrap/VM and direct Beeline operation fetches | Existing machine socket becomes ordinary helper operation adapter; no generic HTTP fallback when selected. Exact command/source credentials and codecs; immutable generation, committed activation snapshot reused once, completion-aware initial pages; new helpers do not reread inbox on activity. | Actual selected socket zero fetch, old wire compatibility ingress, repeated initial failure ≤one incident replacement +24h0, unsubscribe-old closure cannot certify new generation, owner replacement/revoke/lease expiry, same uncertain command identity and zero re-dispatch. Existing helper-turn/activation/usage socket proofs are anchors. |
| R04 | Mobile sign-in/session/funnel, auth OIDC/GitHub, helper pairing/sign-in/join/bootstrap exchange | Existing preauth ceremony/credential owner admits exact destinations, one correlated completion or held request plus one cold recovery; real token expiry refresh once. Authenticated link/reconnect/logout are declared commands, not a public URL fetch escape. Provider OAuth/JWKS transport stays private. | GitHub/Google warm/cold/callback loss/abort/expired tokens/desktop, concurrent refresh single flight, lost one-use exchange UNKNOWN/no repeat, auth completion actual DB LISTEN, old/new JS wire, no idle polling and no reachability preflight. Never inspect actual credential stores. |
| R05 | Phone/helper media, attachments, shared `uploadObject`, `object-storage.ts`, transcription | Metadata/create/finalize/link/play are closed router operations; one declared immutable byte leaf uses scoped capability (object/version/origin/principal), range/byte/disk/concurrency caps and current revoke fences. Remove phone `/link` and `/play` legacy metadata fetch branches after server-first floor; preserve real bytes HTTP/native. Split `uploadObject` hashing/contracts from its raw POST transport. | One preview/open/share/save flight and cache, complete body/JSON envelope bounds, signedURL refresh not new identity, logout/revoke purge, authority replacement during bytes, duplicate upload/finalize/lost response,0 metadataHTTP on selected path; native Image/decoder capture. External upload UNKNOWN/no automatic resubmit. |
| R06 | LiveKit/WebRTC, native voice leave, browser-share/CDP/computer sockets, sandbox/audio WebViews | Existing exact voice/share/view owner grants call/share generation capability; metadata through router. Native leave is one idempotent route for suspended JS; browser/media sockets and WebView remote bytes remain private active-view execution, never a hidden Beeline API fallback. Remove timer reconnect from wrappers and inspect SDK reconnect/prefetch. | Actual active-call/view trace then zero viewers/hidden/released →zero upstream bytes; stale native leave cannot end newer call; revoked provider generation cannot enqueue; controlled disconnect parks until genuine boundary; WebView remote-subresource policy and JS-injected reconnect mutation tests; native40 old/new JS. |
| R07 | Expo/Tauri update owner, helper self-update/adapter install/connect/recovery and package-manager commands | Keep one router-owned update/install operation per real epoch/release/manual action; preserve signature/runtime compatibility and source failure parking. No extra Settings updater or manifest poll. SDK checks explicitly disabled/controlled. One explicit bootstrap/install command may perform its declared package/download work; no background freshness loop. | Shared automatic+manual owner quotas, native/runtime40 compatibility, old store binary unknown APIs, bad signatures/runtime refusal, repeated foreground0, SDK actual24hidle traffic, isolated install/lifecycle proof only with separate HOME/XDG/native manager/repo when root authorizes it. No lifecycle actions in this audit. |
| R08 | Mobile/server/helper Sentry/PostHog/funnel/Telegram/dev logging, shared X pixel | Actual observation/manual diagnostic routes only, bounded batch ≤32KiB/rate/local ring; no periodic idle flush/session replay/autocapture/retry; denial cannot trigger networking. Isolate vendor transports. Remove production log mirroring and shared-contract script injection. | Fake24h plus native/SDK intercept capture, duplicate error/event quota, SDK failure produces no recursive capture/retry, >32KiB denied, no auth URLs/tokens in telemetry, dev log disabled release, signed endpoint scope. Configuration read alone is not SDK-internal proof. |
| R09 | Server external provider adapters: auth GitHub, Composio, Fly, logos/discovery, model/images/embeddings/STT/TTS, CDP/RPC/Link, operator/store/ad/email, X | Convert each actual semantic operation to a closed provider adapter called only by admitted human/command/committed source or persisted actual due record. Keep provider transport outside DB locks; final current authority/source before effect, durable UNKNOWN when ambiguous, proven provider idempotency only where actually supported. No generic public `externalFetch`/URL client. | Synthetic provider entry counters, actual permitted route+scope and denied owner0; lost/timeout/accepted-but-lost completion never resubmits; exact read versus effect classification; provider receipts/signatures same owner/chain/hash; poll removal; direct-caller and SDK retry adversarial tests; provider bytes/cost measured separately. |
| R10 | `database.ts`, `postgres-live.ts`, auth store, APNs/FCM/web-push and server lease/job control | Database pools/LISTEN and push/provider control become exact private infrastructure routes, not feature-granted exceptions. One committed listener/source recovery; no duplicate LISTEN/pools, idle health query, empty due scans or periodic noop writes. Real aggregate lease renewal and earliest persisted expiry retain bounded separate ledger. | Real two-pool LISTEN/recovery/leader-transfer/rollback and actual due-row tests, no empty24h queries/WAL, irrelevant source0, revoke/current authority fences, one push per real eligible delivery, provider failure not new data read. Keep push OS bootstrap separate from metadata registration main socket. |
| R11 | Local IPC/broker/control/port checks and IP-only node:net imports | Classify actual local-only transport separately; do not call `isIP` or address-family setters a remote request. Bind real local socket/probe to command/session/installation owner; broker relay backoff removed (D066, `squire-broker-link.test.ts`); remove remaining timed launch/readiness observations; unavailable parks until actual broker/lifecycle recovery or explicit action. No generic local HTTP proxy that forwards arbitrary server/provider calls. | Unix-socket isolation/permissions/one kernel claim, unavailable24h0 attempts, actual recovery single re-admission, no process spawn from sandbox, stale local owner cannot affect replacement, local networking denied from generic feature code. |
| R12 | Scanned test fixture, browser proof bootstrap, local `blob:`/`data:`, shadowed `fetch`, x-attribution global object | Remove proof-only code from production import graph/package exports; keep pure local parsing/constants classified accurately. Verify local byte helpers reject HTTP and global escape paths cannot expose fetch. Do not mark an actual injected vendor script harmless merely because its hit is `global-object`. | Production transitive import graph and bundle inclusion assertion; local-byte helper HTTP refusal; renamed/shadowed/dynamic/eval/native alias mutation tests. No inventory deletion merely based on filename. |
| R13 | Shared runtime transport exports: `upload-object.ts`, `auth-json.ts`, `http.ts`, `room-view.ts`, `nip05.ts` | Shared API contracts/net core remain pure; retain types/canonical readers/parsers and move execution ownership into existing private platform adapters. Migrate all runtime consumers before removing transport barrels; managed identity/NIP05/auth JSON/invite/pairing operations become exact declared routes or preauth leaves, not arbitrary URL helpers. | Package export/type adversarial tests, all transitive production importers, runtime caller substitution attempts, wrong-origin/caller0, old-server ingress compatibility, bundle/deadcode checks and parity for actual identity/invite/pairing behavior. |
| R14 | Native images/assets, WebView content, Tauri plugin commands, harness/quota/SDK subprocesses and generated programs not fully represented by raw-fetch inventory | Enumerate actual runtime imports and generated source/command entrypoints; prohibit transport-capable dependencies outside exact adapters. Scope native URI/image/prefetch and updater/http commands; command-bound model/tool/quota execution with SDK retries off. Do not claim negative `fetch` grep proves absence. | Locked dependency source/options inspection, built bundle/native manifest/permissions graph, instrumented actual adapter/native WebView/Image/SDK/subprocess traffic under active+24hidle+error/recovery, transitive known network SDK injection mutation; all unmeasured paths stay OPEN. |

## Additional bypasses and coverage gaps beyond migration-site counts

| Exact source / edge | Observation | Removal/ownership decision and proof |
| --- | --- | --- |
| `packages/net/src/routes.ts:365` | All operation leaves are emitted through `legacyEntries`; registry codec coverage is not runtime admission coverage. | R01–R03/R13. Replace exhaustive leaf-by-leaf with owner/trigger/source/effect policy; CI must fail a declared-but-unowned route. Never mechanically declare every leaf migrated. |
| `apps/mobile/sources/sync/transport/monolith-operation.ts:105` → `.request:116,123` | Generic feature operation path; `redeemInvite` has an extra replacement request after ambiguous response. | R02. Explicit human invite action plus stable server idempotency/receipt confirmation through the router; zero implicit second effect. Prove committed-lost response and sameidentity join. |
| `apps/mobile/sources/sync/transport/room-view-client.ts:54` and generic `get/request/checked` | Current inflight dedup depends on global live-frame epoch. Many explicit detail/history/Settings reads still bypass held-lane admission. | R02. Migrate exact semantic leaf and demand/window/key owner, then delete generic getter/export; no broad frame-caused refetch. Existing read-cursor/read-limit tests stay strict. |
| `apps/body/src/daemon-api-client.ts:477` | Ordinary execute posts arbitrary contract operation over HTTP; only activation/usage/turn subsets select existing machine channels. | R03. Complete closed request/reply machine leaves and no selected HTTP fallback; preserve exact daemon credentials at server ingress. |
| `apps/body/src/read-only-mcp.ts:726,2405,2500,2802,2863,4072` | Direct daemon operations, MCP relay/tools, local run/artifact/owed-mention paths; one public tool facade can hide many semantic endpoints. | R03/R05/R09/R11/R14. Bind each tool leaf to its actual command/source/grant and exact adapter; tool execution is not blanket permission for arbitrary observation. Enumerate dynamic operation choices and proof one by one. |
| `apps/body/src/resource-mcp-facade.ts:469,502,549,682` | Direct Beeline approval/login-wall HTTP and external launch request. | R03/R04/R09. Same command-bound resource adapter; preserve Squire ceremony and secret boundaries, no HTTP fallback or retry. |
| `apps/body/src/browser-share-host.ts:45` | Local socket request invokes direct authenticated `endComputerSession` HTTP. | R03/R06/R11. Carry actual share generation through owned command/control route; stale local stop must not end a newer share. |
| `apps/auth/src/external-fetch.ts:11,44` and `apps/auth/src/github.ts:215,235,261,508` | Generic bounded external transport + GitHub wrapper shared across provider effects; timeout does not imply no provider effect. | R04/R09. Exact provider leaves and immutable invocation evidence/UNKNOWN; deadline is termination, not automatic retry permission. |
| `apps/server/src/auth.ts:615`; `cdp-client.ts:317,348`; `evm-chain.ts:149,296`; `next-day-checkin.ts:141`; `store-download-reports.ts:99,180` | Real networking through `externalFetch` is not independently inventoried at semantic caller sites. | R09. Add semantic adapter coverage and source/command/due validation without growing raw-fetch debt. Financial legacy receipt loop at `cdp-client.ts:746` remains a compatibility debt; selected completionV1 one observation/UNKNOWN must never fall back. |
| `apps/server/src/object-storage.ts` | **Implemented and locally tested, broader router ownership not closed:** initial inspection of installed aws4fetch1.0.20 found default `retries=10`, initial retry delay50ms and a retry/sleep loop (`dist/aws4fetch.esm.js:39–40,64–73`). The adapter now sets `retries:0`; signing, presigned upload policies and the existing external deadline stay in place. | R05/R09/R14. New `object-storage.retry.test.ts` exercises real SDK signing/dispatch through synthetic global fetch for PUT/HEAD/GET/DELETE,429/503 and network rejection, then advances24h and requires one attempt. Existing `object-storage.test.ts` deadline proof now holds a real loopback request until abort instead of requiring SDK backoff. Central serial Vitest validation passes: actual SDK attempt-count12 and existing object-storage4. Deployed locked-version evidence and broader router ownership remain OPEN. |
| `apps/mobile/sources/track/tracking.ts:8` | PostHog enables lifecycle capture; no explicit flush/SDK retry configuration in this owner. | R08/R14. One bounded actual-observation telemetry owner; native capture required. Do not exempt it because the manifest says analytics. |
| `packages/api-contract/src/x-attribution.ts:108` | `loadXPixel` creates remote `script.src` and vendor queue; shared contract package can cause browser requests without a fetch call. | R08/R12–R14. Extract pure attribution parsing from exact web telemetry adapter, bound actual signup/attribution observation, inspect vendor effects or retire pixel. No arbitrary script insertion from shared exports. |
| `apps/mobile/sources/hooks/update-provider.ts:133`; `apps/mobile/src-tauri/src/lib.rs:112,148`; `src-tauri/capabilities/default.json` | Tauri HTTP and updater plugins expose network via IPC; plugin-updater is not in current NETWORK_LIBRARIES. Rust plugin registration has no reqwest literal. | R07/R14. Exact update/preauth/bytes owners and native permission scope; deny feature IPC transport; read locked plugin behavior and capture updater traffic. Runtime package import-name grep cannot prove absence. |
| `apps/mobile/app.config.js:261`; `hooks/useUpdates.ts` | Expo periodic checks currently explicitly `NEVER`; existing shared SDK check/download owner remains physical exception. | R07/R14. Preserve disabled SDK check policy, epoch/manual quotas and native40 proof; do not restore Settings SDK calls or invent another compat path. |
| `apps/mobile/sources/components/buzz/AppMark.tsx:75,106` | Google favicon fallback is gone, but supplied remote `mark.uri`/legacy `logo` can still drive native Image requests. | R05/R14. Server-owned cached asset capability and visible-image owner, or local fallback; instrument retained hidden views and native HTTP cache/revalidation. No new favicon request. |
| `apps/mobile/sources/components/buzz/RunnableArtifact.tsx:114`; `VoicePreviewPlayer.native.tsx:38`; `sandbox-webview.ts`; injected `apps/server/src/computer-session.ts:603–637` | WebView URI, injected audio source and generated browser WebSocket reconnect perform requests outside ordinary TS AST call sites. | R06/R14. Visible viewer/source-generation ownership, immutable bytes/cache, no hidden requests/timed reconnect; parse generated programs and capture actual page subrequests. Third-party interactive browsing is explicit external execution, not a Beeline API escape. |
| `apps/body/src/squire-broker-link.ts:162–170` | Repeated local reconnect uses100ms–1s timers for up to10s; local IPC is real repeated transport work even though not WAN. | R11/R14. One admitted local connect and actual readiness/recovery event or explicit action; preserve in-flight outcome uncertainty, zero24hretry, no detached broker launch. |
| `apps/mobile/sources/buzz/use-voice-call.ts:139–140` | Wrapper retries call connection with exponential timer; SDK may also reconnect. | R06/R14. Session-owned actual transport/control evidence; timed failure alone cannot grant another provider attempt. Distinguish terminal deadline from reconnect loop; actual zero-extraattempt proof after failure. |
| `apps/body/src/acp.ts:985`, `harness-quota.ts:65–70,212–227`, Body package dependencies `@earendil-works/pi-*`, `pi-mcp-adapter`, `quota-axi` | Child processes/SDKs perform model, OAuth, MCP and quota network without checked-in fetch literals. Startup/template loader code is not equivalent to vendor source. | R03/R09/R14. Command/source-bound model credential plan remains open; inspect exact locked/published harness adapters/retry settings, one approved quota read per account revision, subprocess egress capture and sandbox capability boundary. Arbitrary external harness browsing/tool execution stays measured separately. |
| `apps/body/src/connector-squire.ts:614,630,778`, `connector-tailscale.ts:188`, `dependency-generation.ts:105`, `adapter-update.ts:67`, `bwrap-sandbox.ts:968–969`, checkout/cache repair Git commands | npm/npx/curl/package-manager/git perform real network outside native fetch inventory; some are installer/explicit repository effects. | R07/R09/R14. Exact installation/repository command owner+credential/purpose, no time-based freshness probes, no auto provider replay. Test command arguments/environment with synthetic exec, then isolated approved lifecycle/network capture; no lifecycle commands here. |
| `apps/auth/src/server-test-fixture.ts`; Body `squire-broker-link.test-support.ts`; mobile `test/browserControlsProof.ts` | Production scanner includes proof-named sources; the label alone does not show whether production imports ship them. | R12. Prove production transitive import/bundle exclusion before deleting debt; otherwise refactor actual production edge. |

## Server ingress coverage required before removal

The raw boundary appendix contains only `server.ts` HTTP/WS imports, not each endpoint. Preserve this separate semantic coverage obligation. Every endpoint group must have exact route/auth/codec/cause/bounds/effect/source registration and an executable denied-before-application/provider-entry proof:

- Main `/v1/phone/live`, phone operation request/reply, router negotiation/read batches/command receipt; machine registration/subscription/claim/activation/usage/turn controls; `/mcp` tool/session/member-stream and OAuth handoff.
- Legacy `/v1/phone/operations/:name`, `/v1/daemon/operations/:name`, `/v1/phone/workspaces/...`, agents/Rooms/history/outline/corners/read/unread/message-links, voice/profile preview and phone observations. These are translated ingress, not second feature dispatchers. `server.ts:2632–2931` contains this current route tail.
- `/v1/phone/media`, `/v1/phone/transcriptions`, `/v1/daemon/artifacts`, uploads/finalize/media and `/v1/media/:id` bytes/link/play; avatar/company/connector marks; exact file exceptions with scoped bytes capability.
- Preauth sign-in/exchange/refresh/logout/review, pairing/daemon exchange/rollback, `/auth/*`, GitHub install/Link/apps/registry MCP OAuth callbacks, public invite preview/minimum version. Stable ceremony ownership and no provider-status loops.
- Existing native voice-stop and `/s/:share` source/view/wait/status/browser sockets. Validate call/share generation, current authority and viewer budgets on final delivery, not a URL shape alone.
- Signed GitHub/CDP/provider/subscription/Sentry webhooks; actual durable completion/source IDs, old/new scope, dedup and grant/owner authority. No unvalidated external payload may mint arbitrary work.
- Operator/admin dashboards, release/minimum/notify controls, site-download/funnel/attribution ingress, health/readiness/version. Exact operator identity/release authority and explicit demand/control; do not delete external health semantics or convert readiness into DB polling.
- Server-internal direct service callers, startup jobs, database triggers/listeners and persisted due work use the same semantic adapters with private source/deadline authority. Inbound requests are not the only path to a provider or DB mutation.

## Final sweep mechanics and limitations

Concrete proof-file plan (new names below are proposed tests to author, not existing passing suites):

| IDs | Exact executable proof location / invocation |
| --- | --- |
| R01 | New server `router-ingress-only.integration.test.ts` and `router-ingress-only.postgres.test.ts`, exercising actual HTTP/phone/machine/MCP ingress against the same operation and two pools. |
| R02 | New mobile `sources/buzz/router-feature-boundaries.test.ts` plus each migrated existing screen/action suite; extend existing `router-owner.test.ts`, `router-tray.test.ts` and navigation/Room tests with network counters; add focused actual scheduled-work owner coverage. |
| R03 | Extend Body `daemon-api-client.integration.test.ts`, `helper-turn-socket.test.ts`, `helper-activation-socket.test.ts`, `helper-usage-socket.test.ts`, `live-link.test.ts` and existing initial-barrier actual-socket proofs; new `router-helper-operation.test.ts` enumerates every selected daemon leaf and asserts zero fetch. |
| R04 | Existing mobile `github-auth-session.test.ts`/`google-auth-session.test.ts`, auth `completion-wait.test.ts`, Body session-join progress/join/member-stream suites and server held-completion proofs; add exact old/new wire and denied callback cases. |
| R05 | Existing mobile media-cache/artifact tests, server object-storage/media authority tests and two-pool media proof; new shared `router-upload-boundary.test.ts` asserts public contracts cannot dispatch bytes and metadata-only operations never use HTTP. |
| R06 | Existing mobile voice-transport native/platform compatibility suites, server voice budget/runtime/service/realPG tests and computer-session tests; new `router-webview-egress.test.ts` parses generated HTML/programs and intercepts hidden/viewer-zero traffic. Device capture remains required. |
| R07 | Existing `hooks/useUpdates.test.ts`/shared update-owner and Settings fixture suites plus helper update/install synthetic tests; existing isolated `scripts/helper-proof/run-linux.sh` only under a separate authorized lifecycle proof. New Tauri updater IPC scope fixture. |
| R08 | New cross-platform `router-telemetry-idle.test.ts`: inject the actual locked SDK transport, advance24h and fail on idle attempt, retry or oversized batch; existing Sentry refusal/privacy tests and release build config assertion. |
| R09 | Existing domain provider suites (CDP completion/chains/wallet/webhooks, GitHub, Composio, Fly, discovery, STT/TTS, email/X/operator) plus new `router-provider-admission.test.ts` denies unowned provider entry and a realPG durable-UNKNOWN test for each financial/external effect adapter. All fixtures synthetic. |
| R10 | Existing realPG retention/presence/SystemDM/leader/deadline/projection/source proofs plus new `router-control-idle.postgres.test.ts` asserting no settled DB queries/noop WAL and bounded aggregate controls under24h controlled clock. |
| R11 | Existing kernel-lock/Squire/local broker/emulator/control fixtures; new `router-local-ipc-recovery.test.ts` asserts failed connect24h0, actual source recovery once, no spawn, stale-generation refusal. |
| R12–R14 | Extend `scripts/router-boundaries.test.mjs`/`phone-network-channels.test.mjs` with transitive SDK/generic executor/native IPC/script/image/generated-source/subprocess/import mutations; new `scripts/router-only-import-graph.test.mjs` checks production bundles/exports against exact adapters. Locked SDK transport/native packet captures complement these tests. |

Root executes focused Vitest files serially with `NODE_OPTIONS=--max-old-space-size=4096` and `--minWorkers=1 --maxWorkers=2`; this audit authored none and ran none. The exact current source test filenames should be resolved before scheduling a row; a proposed test name is not evidence.

The appendix is an extraction, not a green proof suite. Repeat the existing `scanRouterTree`/`scanPhoneTree` AST/native extraction, trusted-base inventory comparison, and source/export graph inspection on the exact removal head. Traverse public/private barrels, dynamic imports/require, generated strings and runtime command templates. Inspect `package-lock.json`, Tauri Cargo/plugin locks, native permissions and package exports without executing installed SDK code or reading owner credentials. Existing detectors recognize named globals/aliases/computed globals/eval/native modules and a fixed SDK list; the list does not include every future or transitive network SDK.

Central executable validation when root authorizes it: `npm run typecheck`; `npm run dead-code`; `node --test scripts/router-boundaries.test.mjs scripts/phone-network-channels.test.mjs`; `node scripts/check-router-boundaries.mjs --base <trusted-merge-base>` and `node scripts/check-phone-network-channels.mjs --base <trusted-merge-base>`; actual focused phone/helper/server route/source/authority/command tests with root's single Vitest slot. Add mutations for arbitrary URL/operation executor, owner export, aliased SDK, moved wrapper, generated source, native HTTP/IPC, subprocess download, skipped test-named module, script/image/WebView and timer→adapter. Never accept an inventory increase or baseline regeneration as a fix.

Built/native capture is required for SDK internals, media/image/WebView, updater and third-party harness egress: runtime40 current-compatible OTA and old-JS ingress; current Android/iOS, web/Tauri; both machines and mixed servers/rollback. Measure physical attempts/bytes plus server statements/journal/WAL/CPU/queue/parse/paint under equal workloads. Settled data observation/projection/noop writes must be exactly zero for24h; intentional active media, push, lease controls and external execution have separate bounded ledgers. Lack of native capture or provider-internal visibility is OPEN evidence, never inferred absence.

Completion is zero unowned edges, zero migration-only entries, every current contract leaf actually owned, no alternate Settings/compat executor, no selected downgrade, supported wire/runtime40 behavior proven, and required workload/SDK/native proofs retained. Permanent authorized private transports remain visible as router adapters. At this snapshot none of those whole-sweep closure claims is made.

## Appendix A — exact currently inventoried router boundaries

Rows below retain the original source path, boundary kind, occurrence count and matching line numbers. They are not a request-frequency measurement. Correction/proof IDs refer to the mandatory per-item catalogue above. Every row is currently `legacy-only` in the source manifest, including otherwise necessary physical adapters.

| Exact source | Boundary | Count | Lines | Fix/proof |
| --- | --- | ---: | --- | --- |
| `apps/auth/src/external-fetch.ts` | `fetch` | 2 | 14, 45 | R04/R09 |
| `apps/auth/src/oidc.ts` | `fetch` | 2 | 77, 188 | R04/R09 |
| `apps/auth/src/server-test-fixture.ts` | `import:node:http` | 1 | 3 | R12 |
| `apps/auth/src/server-test-fixture.ts` | `import:node:net` | 1 | 4 | R12 |
| `apps/auth/src/server-test-fixture.ts` | `fetch` | 1 | 507 | R12 |
| `apps/auth/src/store.ts` | `import:pg` | 1 | 1 | R10 |
| `apps/body/src/agent-corner-checkout.ts` | `fetch` | 2 | 123, 124 | R07/R09/R14 |
| `apps/body/src/agent-runtime.ts` | `fetch` | 2 | 102, 294 | R03/R04/R09 |
| `apps/body/src/agent-sign-in.ts` | `fetch` | 1 | 197 | R04 |
| `apps/body/src/android-emulator-lease.ts` | `import:node:net` | 1 | 4 | R11 |
| `apps/body/src/attachment-delivery.ts` | `fetch` | 2 | 65, 160 | R03/R05 |
| `apps/body/src/attachment-delivery.ts` | `fetch-impl` | 1 | 67 | R03/R05 |
| `apps/body/src/browser-share-host.ts` | `import:node:net` | 1 | 1 | R03/R06/R11 |
| `apps/body/src/browser-share-host.ts` | `fetch` | 1 | 45 | R03/R06/R11 |
| `apps/body/src/browser-share.ts` | `import:ws` | 1 | 1 | R06/R14 |
| `apps/body/src/browser-share.ts` | `fetch` | 1 | 18 | R06/R14 |
| `apps/body/src/browser-share.ts` | `websocket` | 3 | 58, 62, 180 | R06/R14 |
| `apps/body/src/claude-sign-in.ts` | `fetch` | 1 | 177 | R04 |
| `apps/body/src/connect-command.ts` | `fetch-impl` | 2 | 697, 855 | R04/R07/R14 |
| `apps/body/src/connect-command.ts` | `fetch` | 1 | 972 | R04/R07/R14 |
| `apps/body/src/connector-squire.ts` | `fetch` | 1 | 899 | R04/R07/R14 |
| `apps/body/src/corner-emulator.ts` | `import:node:net` | 1 | 24 | R11 |
| `apps/body/src/daemon-api-client.ts` | `fetch` | 3 | 203, 212, 725 | R03/R04/R09 |
| `apps/body/src/daemon-api-client.ts` | `fetch-impl` | 3 | 373, 477, 754 | R03/R04/R09 |
| `apps/body/src/device-pairing.ts` | `fetch` | 1 | 65 | R04 |
| `apps/body/src/free-agent-vm.ts` | `fetch` | 3 | 75, 103, 235 | R03/R04/R09 |
| `apps/body/src/free-agent-vm.ts` | `fetch-impl` | 2 | 106, 240 | R03/R04/R09 |
| `apps/body/src/grant-runner.ts` | `import:node:http` | 3 | 54, 715, 716 | R03/R09/R11/R14 |
| `apps/body/src/institutional-context.ts` | `fetch` | 2 | 81, 85 | R03/R12 |
| `apps/body/src/kernel-lock.ts` | `import:node:net` | 1 | 2 | R11 |
| `apps/body/src/legacy-daemon-migration.ts` | `fetch` | 1 | 14 | R04 |
| `apps/body/src/legacy-daemon-migration.ts` | `fetch-impl` | 1 | 21 | R04 |
| `apps/body/src/live-link.ts` | `import:ws` | 1 | 2 | R03 |
| `apps/body/src/machine-control.ts` | `import:node:net` | 1 | 3 | R11 |
| `apps/body/src/machine-link.ts` | `import:ws` | 1 | 5 | R03 |
| `apps/body/src/machine-link.ts` | `websocket` | 1 | 324 | R03 |
| `apps/body/src/mcp-route-class.ts` | `import:node:net` | 1 | 16 | R11 |
| `apps/body/src/network-family-bootstrap.ts` | `import:node:net` | 1 | 1 | R11 |
| `apps/body/src/openrouter-history.ts` | `fetch` | 1 | 122 | R04/R09/R14 |
| `apps/body/src/openrouter-key-usage.ts` | `fetch-impl` | 1 | 63 | R04/R09/R14 |
| `apps/body/src/openrouter-key-usage.ts` | `fetch` | 1 | 93 | R04/R09/R14 |
| `apps/body/src/openrouter-routing.ts` | `fetch` | 3 | 516, 684, 802 | R04/R09/R14 |
| `apps/body/src/provider-key-check.ts` | `fetch` | 1 | 70 | R04/R09/R14 |
| `apps/body/src/provider-webhooks.ts` | `fetch` | 1 | 170 | R04/R09/R14 |
| `apps/body/src/read-only-mcp.ts` | `fetch` | 8 | 726, 1197, 1471, 2405, 2500, 2802, 2863, 4072 | R03/R05/R09/R11/R14 |
| `apps/body/src/recovery-cli.ts` | `fetch` | 1 | 129 | R04/R07/R14 |
| `apps/body/src/registry-mcp.ts` | `import:node:net` | 1 | 6 | R04/R09/R14 |
| `apps/body/src/registry-mcp.ts` | `fetch` | 3 | 297, 659, 762 | R04/R09/R14 |
| `apps/body/src/repository-cache-repair.ts` | `fetch` | 3 | 201, 208, 214 | R07/R09/R14 |
| `apps/body/src/resource-mcp-facade.ts` | `fetch` | 4 | 451, 484, 529, 682 | R03/R05/R09/R11/R14 |
| `apps/body/src/resource-mcp-facade.ts` | `fetch-impl` | 3 | 469, 502, 549 | R03/R05/R09/R11/R14 |
| `apps/body/src/room-github-auth.ts` | `import:node:http` | 1 | 36 | R03/R09/R11/R14 |
| `apps/body/src/room-github-auth.ts` | `import:node:net` | 1 | 38 | R03/R09/R11/R14 |
| `apps/body/src/self-update-cli.ts` | `fetch` | 1 | 173 | R04/R07/R14 |
| `apps/body/src/self-update.ts` | `fetch-impl` | 2 | 421, 553 | R04/R07/R14 |
| `apps/body/src/self-update.ts` | `fetch` | 2 | 509, 1002 | R04/R07/R14 |
| `apps/body/src/sentry.ts` | `import:@sentry/node` | 1 | 1 | R08/R14 |
| `apps/body/src/session-join/beeline-api.ts` | `fetch` | 1 | 39 | R03/R04 |
| `apps/body/src/session-join/bridge.ts` | `import:node:net` | 1 | 5 | R04/R11/R14 |
| `apps/body/src/session-join/claude.ts` | `import:node:net` | 1 | 9 | R04/R11/R14 |
| `apps/body/src/session-join/command.ts` | `fetch` | 1 | 337 | R03/R04 |
| `apps/body/src/squire-broker-link.test-support.ts` | `import:node:net` | 1 | 9 | R12 |
| `apps/body/src/squire-broker-link.ts` | `import:node:net` | 1 | 40 | R04/R11/R14 |
| `apps/body/src/squire-host.ts` | `import:node:net` | 1 | 28 | R04/R11/R14 |
| `apps/body/src/squire-task-relay.ts` | `import:node:http` | 1 | 8 | R03/R11 |
| `apps/body/src/squire-task-relay.ts` | `fetch` | 2 | 693, 726 | R03/R11 |
| `apps/body/src/storage-owners.ts` | `fetch` | 1 | 267 | R03/R07 |
| `apps/body/src/storage-report.ts` | `fetch` | 1 | 31 | R03/R07 |
| `apps/mobile/modules/voice-background-audio/android/src/main/java/app/usebeeline/voicebackgroundaudio/VoiceStopRequests.kt` | `native-http` | 1 | 31 | R06 |
| `apps/mobile/modules/voice-background-audio/ios/VoiceBackgroundAudioModule.swift` | `native-http` | 1 | 65 | R06 |
| `apps/mobile/sources/app/_layout.tsx` | `import:posthog-react-native` | 1 | 29 | R08/R14 |
| `apps/mobile/sources/auth/github-auth-session.ts` | `fetch` | 1 | 117 | R04 |
| `apps/mobile/sources/auth/github-auth-session.ts` | `import:@tauri-apps/plugin-http` | 1 | 118 | R04 |
| `apps/mobile/sources/auth/github-auth-session.ts` | `fetch-impl` | 2 | 349, 397 | R04 |
| `apps/mobile/sources/auth/google-auth-session.ts` | `fetch` | 1 | 43 | R04 |
| `apps/mobile/sources/auth/monolith-session.ts` | `fetch` | 1 | 25 | R04 |
| `apps/mobile/sources/auth/monolith-session.ts` | `import:@tauri-apps/plugin-http` | 1 | 27 | R04 |
| `apps/mobile/sources/auth/monolith-session.ts` | `fetch-impl` | 7 | 137, 154, 168, 188, 308, 466, 513 | R04 |
| `apps/mobile/sources/auth/signin-funnel.ts` | `fetch` | 1 | 46 | R04/R08 |
| `apps/mobile/sources/auth/signin-funnel.ts` | `import:@tauri-apps/plugin-http` | 1 | 46 | R04/R08 |
| `apps/mobile/sources/buzz/artifact-link.ts` | `session-fetch` | 3 | 68, 121, 146 | R05 |
| `apps/mobile/sources/buzz/sentry.ts` | `import:@sentry/react-native` | 1 | 2 | R08/R14 |
| `apps/mobile/sources/buzz/speech-transcription.ts` | `session-fetch` | 1 | 69 | R05 |
| `apps/mobile/sources/buzz/store-update.ts` | `fetch` | 1 | 10 | R07 |
| `apps/mobile/sources/buzz/use-voice-call.ts` | `import:livekit-client` | 1 | 4 | R06/R14 |
| `apps/mobile/sources/buzz/voice-transport.native.ts` | `import:livekit-client` | 1 | 3 | R06/R14 |
| `apps/mobile/sources/buzz/voice-transport.native.ts` | `import:@livekit/react-native` | 1 | 72 | R06/R14 |
| `apps/mobile/sources/buzz/voice-transport.ts` | `import:livekit-client` | 1 | 2 | R06/R14 |
| `apps/mobile/sources/buzz/web-chunk-recovery.web.ts` | `fetch` | 1 | 19 | R07 |
| `apps/mobile/sources/components/buzz/VaultSaveCard.tsx` | `session-fetch` | 1 | 79 | R04/R05 |
| `apps/mobile/sources/components/buzz/VoicePreviewPlayer.native.tsx` | `import:react-native-webview` | 1 | 17 | R06/R14 |
| `apps/mobile/sources/components/buzz/sandbox-webview.ts` | `import:react-native-webview` | 1 | 20 | R06/R14 |
| `apps/mobile/sources/hooks/useUpdates.ts` | `ota-update` | 2 | 20, 23 | R07 |
| `apps/mobile/sources/push/buzz-push-registration.ts` | `push-token` | 2 | 258, 384 | R10/R14 |
| `apps/mobile/sources/sync/transport/live-connection.ts` | `websocket` | 1 | 709 | R01/R02 |
| `apps/mobile/sources/sync/transport/monolith-rig-transport.ts` | `session-fetch` | 1 | 344 | R05 |
| `apps/mobile/sources/test/browserControlsProof.ts` | `computed-import` | 1 | 1 | R12 |
| `apps/mobile/sources/track/tracking.ts` | `import:posthog-react-native` | 1 | 2 | R08/R14 |
| `apps/mobile/sources/utils/consoleLogging.ts` | `fetch` | 1 | 73 | R08/R14 |
| `apps/mobile/sources/utils/readFileBytes.ts` | `fetch` | 1 | 3 | R12 |
| `apps/mobile/sources/utils/readFileBytes.web.ts` | `fetch` | 1 | 6 | R12 |
| `apps/mobile/src-tauri/src/lib.rs` | `global-object` | 1 | 156 | R04/R07/R14 |
| `apps/server/src/apns-push.ts` | `import:node:http2` | 1 | 7 | R10 |
| `apps/server/src/company-logos.ts` | `import:node:https` | 1 | 2 | R09/R14 |
| `apps/server/src/company-mcp-discovery.ts` | `import:node:https` | 1 | 2 | R09/R14 |
| `apps/server/src/composio-apps.ts` | `fetch` | 1 | 421 | R09/R14 |
| `apps/server/src/computer-session.ts` | `import:node:net` | 1 | 2 | R06/R11/R14 |
| `apps/server/src/computer-session.ts` | `import:ws` | 1 | 7 | R06/R11/R14 |
| `apps/server/src/computer-session.ts` | `fetch` | 2 | 434, 1109 | R06/R11/R14 |
| `apps/server/src/computer-session.ts` | `websocket` | 1 | 983 | R06/R11/R14 |
| `apps/server/src/database.ts` | `import:pg` | 1 | 86 | R10 |
| `apps/server/src/firebase-push.ts` | `import:firebase-admin` | 2 | 9, 10 | R10 |
| `apps/server/src/fly-machines.ts` | `fetch` | 1 | 49 | R09/R14 |
| `apps/server/src/fly-machines.ts` | `fetch-impl` | 1 | 135 | R09/R14 |
| `apps/server/src/free-agent-image-input.ts` | `fetch` | 1 | 8 | R09/R14 |
| `apps/server/src/free-agent-model-proxy.ts` | `fetch` | 1 | 542 | R09/R14 |
| `apps/server/src/index.ts` | `fetch` | 2 | 384, 636 | R01/R09/R10 |
| `apps/server/src/institutional-memory-embeddings.ts` | `fetch` | 1 | 107 | R09/R14 |
| `apps/server/src/link-agent-wallet.ts` | `fetch` | 1 | 25 | R09/R14 |
| `apps/server/src/mcp-registry.ts` | `fetch` | 1 | 120 | R09/R14 |
| `apps/server/src/object-storage.ts` | `import:aws4fetch` | 1 | 19 | R05/R09/R14 |
| `apps/server/src/object-storage.ts` | `global-object` | 1 | 72 | R05/R09/R14 |
| `apps/server/src/operator-dashboard-services.ts` | `fetch` | 1 | 90 | R09/R14 |
| `apps/server/src/operator-dashboard-services.ts` | `fetch-impl` | 1 | 95 | R09/R14 |
| `apps/server/src/operator-finances.ts` | `fetch` | 1 | 53 | R09/R14 |
| `apps/server/src/operator-finances.ts` | `fetch-impl` | 1 | 61 | R09/R14 |
| `apps/server/src/postgres-live.ts` | `import:pg` | 1 | 5 | R10 |
| `apps/server/src/rooms-mcp-logos.ts` | `import:node:https` | 1 | 2 | R09/R14 |
| `apps/server/src/rooms-mcp-members.ts` | `import:node:net` | 1 | 5 | R09/R14 |
| `apps/server/src/rooms-mcp-members.ts` | `import:node:https` | 1 | 6 | R09/R14 |
| `apps/server/src/rooms-mcp.ts` | `import:@modelcontextprotocol/sdk` | 3 | 9, 10, 11 | R01 |
| `apps/server/src/sentry-telegram.ts` | `fetch` | 1 | 49 | R08/R14 |
| `apps/server/src/sentry.ts` | `import:@sentry/node` | 1 | 3 | R08/R14 |
| `apps/server/src/server.ts` | `import:node:http` | 1 | 32 | R01 |
| `apps/server/src/server.ts` | `import:ws` | 1 | 33 | R01 |
| `apps/server/src/speech-transcription.ts` | `fetch` | 1 | 20 | R09/R14 |
| `apps/server/src/speech-transcription.ts` | `fetch-impl` | 1 | 45 | R09/R14 |
| `apps/server/src/voice-providers.ts` | `import:ws` | 1 | 4 | R06/R09/R14 |
| `apps/server/src/voice-providers.ts` | `websocket` | 1 | 78 | R06/R09/R14 |
| `apps/server/src/voice-providers.ts` | `fetch` | 3 | 203, 378, 401 | R06/R09/R14 |
| `apps/server/src/voice-providers.ts` | `fetch-impl` | 3 | 243, 380, 414 | R06/R09/R14 |
| `apps/server/src/voice-room-runtime.ts` | `import:livekit-server-sdk` | 1 | 10 | R06/R09/R14 |
| `apps/server/src/voice-room-runtime.ts` | `import:@livekit/rtc-node` | 1 | 12 | R06/R09/R14 |
| `apps/server/src/voice-service.ts` | `import:livekit-server-sdk` | 1 | 8 | R06/R09/R14 |
| `apps/server/src/web-push.ts` | `import:web-push` | 1 | 1 | R10 |
| `apps/server/src/web-push.ts` | `import:node:https` | 1 | 3 | R10 |
| `apps/server/src/web-push.ts` | `import:node:net` | 1 | 4 | R10 |
| `apps/server/src/x-ad-reports.ts` | `fetch` | 1 | 27 | R09/R14 |
| `apps/server/src/x-ads.ts` | `fetch` | 1 | 74 | R09/R14 |
| `apps/server/src/x-site-visits.ts` | `fetch` | 1 | 17 | R09/R14 |
| `packages/api-contract/src/upload-object.ts` | `fetch` | 1 | 54 | R05/R13 |
| `packages/api-contract/src/x-attribution.ts` | `global-object` | 1 | 98 | R08/R12/R13/R14 |
| `packages/buzz-client/src/auth-json.ts` | `fetch` | 1 | 103 | R02/R04/R13 |
| `packages/buzz-client/src/http.ts` | `fetch` | 2 | 50, 105 | R02/R04/R13 |
| `packages/buzz-client/src/nip05.ts` | `fetch` | 1 | 103 | R02/R04/R13 |
| `packages/buzz-client/src/nip05.ts` | `fetch-impl` | 1 | 112 | R02/R04/R13 |
| `packages/buzz-client/src/room-view.ts` | `fetch` | 1 | 62 | R02/R04/R13 |
| `packages/buzz-client/src/room-view.ts` | `fetch-impl` | 1 | 152 | R02/R04/R13 |


## Appendix B — exact phone channel manifest

`fate:link` and origin-only entries are not automatic connections. Existing `exception` does not exempt a path from router ownership, byte bounds or SDK proof. Preserve the phone scanner ratchet while removing feature bypasses.

| Exact source | Boundary | Manifest count | Actual lines | Current fate | Fix/proof |
| --- | --- | ---: | --- | --- | --- |
| `apps/mobile/sources/sync/transport/live-connection.ts` | `websocket` | 1 | 709 | main-socket | R01/R02 |
| `apps/mobile/sources/auth/monolith-session.ts` | `fetch` | 1 | 25 | exception | R04 |
| `apps/mobile/sources/auth/monolith-session.ts` | `import:@tauri-apps/plugin-http` | 1 | 27 | exception | R04 |
| `apps/mobile/sources/components/buzz/VaultSaveCard.tsx` | `session-fetch` | 1 | 79 | exception | R04/R05 |
| `apps/mobile/modules/voice-background-audio/android/src/main/java/app/usebeeline/voicebackgroundaudio/VoiceStopRequests.kt` | `native-http` | 1 | 31 | exception | R06 |
| `apps/mobile/modules/voice-background-audio/ios/VoiceBackgroundAudioModule.swift` | `native-http` | 1 | 65 | exception | R06 |
| `apps/mobile/sources/app/_layout.tsx` | `import:posthog-react-native` | 1 | 29 | exception | R08/R14 |
| `apps/mobile/sources/auth/github-auth-session.ts` | `fetch` | 1 | 117 | exception | R04 |
| `apps/mobile/sources/auth/github-auth-session.ts` | `fetch-impl` | 2 | 349, 397 | exception | R04 |
| `apps/mobile/sources/auth/github-auth-session.ts` | `import:@tauri-apps/plugin-http` | 1 | 118 | exception | R04 |
| `apps/mobile/sources/auth/google-auth-session.ts` | `fetch` | 1 | 43 | exception | R04 |
| `apps/mobile/sources/auth/monolith-session.ts` | `fetch-impl` | 7 | 137, 154, 168, 188, 308, 466, 513 | exception | R04 |
| `apps/mobile/sources/auth/signin-funnel.ts` | `fetch` | 1 | 46 | exception | R04/R08 |
| `apps/mobile/sources/auth/signin-funnel.ts` | `import:@tauri-apps/plugin-http` | 1 | 46 | exception | R04/R08 |
| `apps/mobile/sources/buzz/artifact-link.ts` | `session-fetch` | 3 | 68, 121, 146 | exception | R05 |
| `apps/mobile/sources/buzz/runtime-config.ts` | `origin:server.usebeeline.app` | 2 | 3, 10 | exception | R12/R01 |
| `apps/mobile/sources/buzz/sentry.ts` | `import:@sentry/react-native` | 1 | 2 | exception | R08/R14 |
| `apps/mobile/sources/buzz/speech-transcription.ts` | `session-fetch` | 1 | 69 | exception | R05 |
| `apps/mobile/sources/buzz/store-update.ts` | `fetch` | 1 | 10 | exception | R07 |
| `apps/mobile/sources/buzz/use-voice-call.ts` | `import:livekit-client` | 1 | 4 | exception | R06/R14 |
| `apps/mobile/sources/buzz/voice-transport.native.ts` | `import:@livekit/react-native` | 1 | 72 | exception | R06/R14 |
| `apps/mobile/sources/buzz/voice-transport.native.ts` | `import:livekit-client` | 1 | 3 | exception | R06/R14 |
| `apps/mobile/sources/buzz/voice-transport.ts` | `import:livekit-client` | 1 | 2 | exception | R06/R14 |
| `apps/mobile/sources/buzz/web-chunk-recovery.web.ts` | `fetch` | 1 | 19 | exception | R07 |
| `apps/mobile/sources/components/buzz/VoicePreviewPlayer.native.tsx` | `import:react-native-webview` | 1 | 17 | exception | R06/R14 |
| `apps/mobile/sources/components/buzz/sandbox-webview.ts` | `import:react-native-webview` | 1 | 20 | exception | R06/R14 |
| `apps/mobile/sources/hooks/useUpdates.ts` | `ota-update` | 2 | 20, 23 | exception | R07 |
| `apps/mobile/sources/push/buzz-push-registration.ts` | `push-token` | 2 | 258, 384 | exception | R10/R14 |
| `apps/mobile/sources/sync/transport/monolith-rig-transport.ts` | `session-fetch` | 1 | 344 | exception | R05 |
| `apps/mobile/sources/track/tracking.ts` | `import:posthog-react-native` | 1 | 2 | exception | R08/R14 |
| `apps/mobile/sources/track/tracking.ts` | `origin:us.i.posthog.com` | 1 | 9 | exception | R12 |
| `apps/mobile/sources/utils/consoleLogging.ts` | `fetch` | 1 | 73 | exception | R08/R14 |
| `apps/mobile/sources/utils/readFileBytes.ts` | `fetch` | 1 | 3 | exception | R12 |
| `apps/mobile/sources/utils/readFileBytes.web.ts` | `fetch` | 1 | 6 | exception | R12 |
| `apps/mobile/sources/app/(app)/beeline/community.tsx` | `origin:usebeeline.app` | 1 | 201 | link | R12 |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx` | `origin:github.com` | 1 | 432 | link | R12 |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx` | `origin:usebeeline.app` | 2 | 90, 91 | link | R12 |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/service.tsx` | `origin:trustysquire.ai` | 1 | 28 | link | R12 |
| `apps/mobile/sources/auth/google-auth-session.ts` | `origin:accounts.google.com` | 1 | 73 | link | R12 |
| `apps/mobile/sources/auth/signin-funnel.ts` | `origin:beeline-server.fly.dev` | 1 | 37 | link | R12 |
| `apps/mobile/sources/auth/signin-funnel.ts` | `origin:server.usebeeline.app` | 1 | 37 | link | R12 |
| `apps/mobile/sources/buzz/artifact-pdf.ts` | `origin:artifact.usebeeline.app` | 1 | 30 | link | R12 |
| `apps/mobile/sources/buzz/beeline-glyph.ts` | `origin:www.w3.org` | 1 | 113 | link | R12 |
| `apps/mobile/sources/buzz/pr-lifecycle.ts` | `origin:github.com` | 1 | 152 | link | R12 |
| `apps/mobile/sources/buzz/runtime-config.ts` | `origin:usebeeline.app` | 2 | 8, 22 | link | R12/R01 |
| `apps/mobile/sources/buzz/store-update.ts` | `origin:apps.apple.com` | 1 | 26 | link | R12 |
| `apps/mobile/sources/buzz/store-update.ts` | `origin:play.google.com` | 1 | 25 | link | R12 |
| `apps/mobile/sources/buzz/voice-update.ts` | `origin:apps.apple.com` | 1 | 10 | link | R12 |
| `apps/mobile/sources/buzz/wallet-source.mock.ts` | `origin:basescan.org` | 3 | 80, 109, 119 | link | R12 |
| `apps/mobile/sources/buzz/workbench-source.mock.ts` | `origin:accounts.google.com` | 1 | 309 | link | R12 |
| `apps/mobile/sources/buzz/workbench-source.mock.ts` | `origin:example.test` | 1 | 430 | link | R12 |
| `apps/mobile/sources/buzz/workbench-source.mock.ts` | `origin:login.example-squire.test` | 1 | 362 | link | R12 |
| `apps/mobile/sources/buzz/workbench-source.mock.ts` | `origin:login.link.com` | 1 | 304 | link | R12 |
| `apps/mobile/sources/components/buzz/RoomRepositorySubtitle.tsx` | `origin:github.com` | 1 | 7 | link | R12 |


## Appendix C — literal generic-operation callers

These AST-derived call expressions identify direct literal operations through the existing generic facades and low-level socket request bridge, grouped by source file. They are candidates requiring R01/R02/R03/R13 disposition, not a claim that each is an extra physical socket or that all are currently unguarded. Existing selected owners must remain and be proven rather than migrated twice. Computed operation arguments are listed separately because a literal-name scan cannot establish their closed route set. Dynamic facade dispatch, wrappers and generated/vendor requests remain covered by the obligations above.

Literal call candidates: 397. Computed argument candidates: 10. This extraction does not infer the target of every `.execute`/`.operation`; resolve the actual import/receiver before changing a candidate.

| Exact source | Calls (`expression@line → argument`) |
| --- | --- |
| `apps/body/src/agent-command-catalog.ts` | `input.api .execute@17 → 'postAgentCommands'` |
| `apps/body/src/agent-runtime.ts` | `daemonApi.execute@157 → 'getAgentConfiguration'`; `daemonApi.execute@300 → 'authorizeResourceCall'`; `daemonApi.execute@395 → 'postAgentMachineReport'` |
| `apps/body/src/agent-sign-in.ts` | `api.execute@420 → 'reportAgentSignIn'`; `api.execute@443 → 'reportAgentSignIn'` |
| `apps/body/src/agent-usage-refresh.ts` | `api.execute@24 → 'postAgentUsage'`; `api.execute@30 → 'getAgentConfiguration'`; `api.execute@35 → 'postAgentUsage'`; `api.execute@44 → 'getAgentConfiguration'`; `api.execute@60 → 'answerUsageRefresh'` |
| `apps/body/src/cli.ts` | `activated.client.execute@212 → 'getRoomGitHubToken'` |
| `apps/body/src/command-fixture.test-support.ts` | `api.execute@25 → 'getRoomInbox'`; `target.execute@92 → 'getRoomInbox'` |
| `apps/body/src/connector-assignments.ts` | `this.api.execute@192 → 'getConnectorAssignments'`; `this.api.execute@223 → 'completeProviderWebhookAssignment'`; `this.api.execute@232 → 'completeProviderWebhookAssignment'`; `this.api.execute@239 → 'postConnectorStatus'`; `this.api.execute@290 → 'installConnector'`; `this.api.execute@314 → 'postConnectorStatus'`; `this.api.execute@329 → 'postConnectorStatus'`; `this.api.execute@354 → 'postConnectorStatus'`; `this.api.execute@372 → 'installConnector'`; `this.api.execute@380 → 'postConnectorStatus'`; `this.api.execute@429 → 'postConnectorStatus'`; `this.api.execute@441 → 'postConnectorStatus'`; `this.api.execute@459 → 'postConnectorStatus'`; `this.api.execute@470 → 'installConnector'`; `this.api.execute@483 → 'postConnectorStatus'`; `this.api.execute@498 → 'getConnectorStatus'`; `this.api.execute@534 → 'revokeConnectionGrants'`; `this.api.execute@557 → 'postConnectorVault'` |
| `apps/body/src/connector-runner.ts` | `api.execute@144 → 'postConnectionUsage'` |
| `apps/body/src/force-update-journal.ts` | `api.execute@101 → 'postAgentTurnReceipt'`; `api.execute@110 → 'postAgentTurnReceipt'` |
| `apps/body/src/grant-runner.ts` | `this.options.api.execute@439 → 'listTurnAgentGrants'`; `this.options.api.execute@473 → 'consumeAgentGrant'`; `this.options.api.execute@560 → 'postAgentActivity'` |
| `apps/body/src/helper-usage-binding.ts` | `api.execute@10 → 'publishAgentUsageAccount'`; `api.execute@11 → 'attachAgentUsageAccount'`; `api.execute@32 → 'postAgentUsage'`; `api.execute@44 → 'postAgentUsage'` |
| `apps/body/src/institutional-context.ts` | `api.execute@58 → 'getInstitutionalContext'` |
| `apps/body/src/model-catalog-sync.ts` | `input.api.execute@99 → 'getAgentConfiguration'`; `input.api.execute@129 → 'postAgentModelCatalog'` |
| `apps/body/src/monolith-corner-turn.ts` | `options.api.execute@658 → 'authorizeResourceCall'`; `options.api .execute@669 → 'postSquireApprovalDecision'`; `options.api.execute@675 → 'endComputerSession'`; `options.api.execute@677 → 'refreshComputerSession'`; `options.api.execute@679 → 'forgetSquireSignIn'`; `this.options.api.execute@682 → 'readAgentWorkbench'`; `this.options.api.execute@798 → 'getAgentConfiguration'`; `this.options.api.execute@804 → 'getCornerRestoreState'`; `this.options.api.execute@809 → 'getRoomRepositoryState'`; `this.options.api.execute@814 → 'getWorkspaceRoster'`; `api.execute@945 → 'postRoomMessage'`; `api.execute@949 → 'postAgentTurnReceipt'`; `this.options.api.execute@1008 → 'listAgentGrants'`; `this.options.api .execute@1635 → 'postAgentModelCatalog'`; `this.options.api.execute@1664 → 'getCornerRestoreState'`; `this.options.api.execute@1676 → 'getPrChecksStatus'`; `api.execute@1866 → 'getInstitutionalMemoryTurnStats'`; `api.execute@1890 → 'postAgentTurnReceipt'`; `api.execute@1941 → 'getRoomConversation'`; `api.execute@1952 → 'listRoomCorners'`; `api.execute@2057 → 'listCornerBriefRevisions'`; `api.execute@2258 → 'postAgentActivity'`; `api.execute@2368 → 'postBackgroundToolCompletion'`; `api.execute@2683 → 'postAgentTurnReceipt'`; `api.execute@2712 → 'postAgentTurnReceipt'`; `this.options.api.execute@2802 → 'getRoomGitHubToken'`; `api.execute@2901 → 'getCornerRestoreState'` |
| `apps/body/src/monolith-room-turn.ts` | `options.api.execute@681 → 'authorizeResourceCall'`; `options.api .execute@692 → 'postSquireApprovalDecision'`; `options.api.execute@703 → 'endComputerSession'`; `options.api.execute@706 → 'refreshComputerSession'`; `options.api.execute@708 → 'forgetSquireSignIn'`; `this.options.api.execute@712 → 'readAgentWorkbench'`; `this.options.api.execute@869 → 'getAgentConfiguration'`; `this.options.api.execute@874 → 'getWorkspaceRoster'`; `this.options.api.execute@911 → 'getRoomRepositoryState'`; `this.options.api.execute@1082 → 'listAgentGrants'`; `this.options.api .execute@1614 → 'postAgentModelCatalog'`; `api.execute@1793 → 'getInstitutionalMemoryTurnStats'`; `api.execute@1817 → 'postAgentTurnReceipt'`; `api.execute@1848 → 'postAgentActivity'`; `api.execute@1879 → 'getRoomConversation'`; `api.execute@1882 → 'listRoomCorners'`; `api.execute@2313 → 'postAgentTurnReceipt'`; `api.execute@2382 → 'postAgentTurnReceipt'`; `api.execute@2412 → 'postAgentTurnReceipt'` |
| `apps/body/src/read-only-mcp.ts` | `daemonExecute@781 → 'getRoomRepositoryState'`; `daemonExecute@793 → 'createCorner'`; `daemonExecute@835 → 'reviseCornerBrief'`; `daemonExecute@857 → 'listCornerBriefRevisions'`; `daemonExecute@884 → 'archiveCorner'`; `daemonExecute@895 → 'reportFeedback'`; `daemonExecute@921 → 'getCornerRestoreState'`; `daemonExecute@924 → 'getRoomConversation'`; `daemonExecute@925 → 'getRoomAuthority'`; `daemonExecute@944 → 'getPrChecksStatus'`; `daemonExecute@1028 → 'approveCornerMerge'`; `daemonExecute@1258 → 'getRoomMessage'`; `daemonExecute@1262 → 'getRoomMessage'`; `daemonExecute@1268 → 'listCornerBriefRevisions'`; `daemonExecute@1607 → 'postAgentAttachment'`; `deps.execute@1863 → 'reactToRoomMessage'`; `deps.execute@1886 → 'createAgentSchedule'`; `deps.execute@1910 → 'listAgentSchedules'`; `deps.execute@1967 → 'setEventSubscriptions'`; `deps.execute@1979 → 'setWakeDelivery'`; `deps.execute@1986 → 'listEventSubscriptions'`; `deps.execute@2031 → 'postRoomEvent'`; `deps.execute@2061 → 'updateAgentSchedule'`; `deps.execute@2084 → 'deleteAgentSchedule'`; `deps.execute@2234 → 'requestAgentGrant'`; `deps.execute@2308 → 'requestAgentGrant'`; `deps.execute@2327 → 'listAgentGrantRequests'`; `daemonExecute@2442 → 'postConnectorVault'`; `daemonExecute@2447 → 'postConnectorVault'`; `daemonExecute@2547 → 'postComputerSession'`; `daemonExecute@2557 → 'postComputerSession'`; `daemonExecute@2568 → 'endComputerSession'`; `deps.execute@2583 → 'readAgentWorkbench'`; `deps.execute@2701 → 'offerConnector'`; `deps.execute@2751 → 'askRoomChoice'`; `deps.execute@2771 → 'openRoomPoll'`; `daemonExecute@3150 → 'listAgentSchedules'`; `daemonExecute@3151 → 'listAgentSubscriptions'`; `daemonExecute@3152 → 'listAgentWatches'`; `daemonExecute@3153 → 'listEventSubscriptions'`; `daemonExecute@3159 → 'listServiceSubscriptionEvents'`; `daemonExecute@3172 → 'watchCorner'`; `daemonExecute@3191 → 'getRoomRepositoryState'`; `daemonExecute@3212 → 'getRoomMessage'`; `daemonExecute@3249 → 'loadWorkspaceSkill'`; `daemonExecute@3266 → 'saveSkill'`; `daemonExecute@3276 → 'deleteSkill'`; `daemonExecute@3286 → 'saveWorkflow'`; `daemonExecute@3294 → 'startWorkflow'`; `daemonExecute@3302 → 'getWorkflowRun'`; `daemonExecute@3308 → 'cancelWorkflowRun'`; `daemonExecute@3316 → 'handoff'`; `daemonExecute@3328 → 'archiveWorkflow'`; `daemonExecute@3336 → 'assignWorkflowRole'`; `daemonExecute@3346 → 'searchInstitutionalHistory'`; `daemonExecute@3355 → 'searchInstitutionalMemory'`; `daemonExecute@3366 → 'notifyFeedbackFixed'`; `daemonExecute@3376 → 'saveInstitutionalMemory'`; `daemonExecute@3390 → 'updateInstitutionalMemory'`; `daemonExecute@3403 → 'deleteInstitutionalMemory'`; `daemonExecute@3415 → 'reportInstitutionalMemoryUsed'`; `daemonExecute@3424 → 'getWalletToolState'`; `daemonExecute@3431 → 'getWalletToolBalance'`; `daemonExecute@3438 → 'getWalletToolChains'`; `daemonExecute@3445 → 'getWalletToolHistory'`; `daemonExecute@3453 → 'getWalletToolQuote'`; `daemonExecute@3463 → 'walletPay'`; `daemonExecute@3475 → 'walletSwap'`; `daemonExecute@3488 → 'walletContractCall'`; `daemonExecute@3504 → 'walletSignTypedData'`; `daemonExecute@3515 → 'setCornerHold'`; `daemonExecute@3524 → 'sendOperatorSystemDm'`; `daemonExecute@3530 → 'readOperatorSystemDm'`; `daemonExecute@3536 → 'orderCornerMerge'`; `daemonExecute@3551 → 'getAgentUsage'`; `daemonExecute@3559 → 'order'`; `daemonExecute@3563 → 'stopAgentTurn'`; `daemonExecute@3568 → 'markAgentTurnSilent'`; `daemonExecute@3577 → 'report'`; `daemonExecute@3579 → 'read'`; `daemonExecute@3609 → 'getRoomConversation'`; `daemonExecute@3645 → 'getRoomConversation'`; `daemonExecute@3702 → 'getCornerRestoreState'`; `daemonExecute@3708 → 'getPrChecksStatus'`; `daemonExecute@3751 → 'dispatchRoomWorkflow'`; `daemonExecute@3757 → 'mergeCorner'`; `daemonExecute@3761 → 'closeCornerPullRequest'`; `daemonExecute@3764 → 'listRooms'`; `daemonExecute@3767 → 'listReachableCorners'`; `daemonExecute@3774 → 'listRoomMembers'`; `daemonExecute@3784 → 'readCornerPullRequest'`; `daemonExecute@3792 → 'postCornerMessage'`; `daemonExecute@3803 → 'getAgentAvatar'`; `daemonExecute@3807 → 'postAgentAvatar'`; `daemonExecute@3817 → 'postVaultSaveCard'`; `daemonExecute@3823 → 'endComputerSession'`; `daemonExecute@3830 → 'renameCorner'`; `daemonExecute@3849 → 'createAgentSubscription'`; `daemonExecute@3862 → 'listAgentSubscriptions'`; `daemonExecute@3864 → 'listServiceSubscriptionEvents'`; `daemonExecute@3870 → 'deleteAgentSubscription'`; `daemonExecute@3878 → 'getWakeDelivery'`; `deps.execute@3881 → 'watchCorner'`; `daemonExecute@3930 → 'createLinkSpendRequest'`; `daemonExecute@3945 → 'retrieveLinkSpendRequest'`; `daemonExecute@3966 → 'connect'`; `daemonExecute@3971 → 'connect'`; `daemonExecute@3977 → 'findConnectors'`; `daemonExecute@3986 → 'connectApp'`; `daemonExecute@3999 → 'listAppTools'`; `daemonExecute@4011 → 'executeAppTool'`; `daemonExecute@4020 → 'postStarterVideoPreview'`; `daemonExecute@4022 → 'postStarterWelcome'`; `daemonExecute@4024 → 'postRoomInvite'`; `daemonExecute@4027 → 'postRepositoryOnboarding'` |
| `apps/body/src/registry-mcp.ts` | `input.api.execute@319 → 'claimRegistryMcpOAuthCode'`; `input.api.execute@472 → 'beginRegistryMcpOAuth'` |
| `apps/body/src/room-runtime.ts` | `this.options.daemonApi.execute@833 → 'getDaemonBootstrap'`; `this.options.daemonApi.execute@917 → 'listRoomCorners'`; `this.options.daemonApi .execute@1286 → 'noteEmptyRoomRepository'`; `this.options.daemonApi.execute@1354 → 'getCornerRestoreState'`; `this.options.daemonApi.execute@1428 → 'getRoomGitHubToken'`; `this.options.daemonApi.execute@1457 → 'postCornerRemoteState'`; `this.options.daemonApi.execute@1670 → 'listRoomCorners'`; `this.options.daemonApi.execute@1712 → 'getRoomRepositoryState'`; `this.options.daemonApi.execute@1730 → 'getRoomGitHubToken'`; `this.options.daemonApi.execute@1756 → 'getAgentCommands'`; `this.options.daemonApi.execute@1772 → 'postAgentTurnReceipt'`; `this.options.daemonApi.execute@1942 → 'getCornerRestoreState'`; `this.options.daemonApi.execute@1988 → 'getCornerRestoreState'`; `this.options.daemonApi.execute@2021 → 'getCornerRestoreState'`; `this.options.daemonApi.execute@2051 → 'getCornerRestoreState'` |
| `apps/body/src/server-command-intake.ts` | `api.execute@156 → 'getAgentCommands'`; `api .execute@195 → 'getAgentCommands'`; `api.execute@273 → 'claimAgentCommand'`; `api.execute@336 → 'acknowledgeAgentCommand'`; `api.execute@351 → 'getAgentCommands'`; `api.execute@374 → 'postAgentTurnReceipt'` |
| `apps/body/src/turn-receipt-heartbeat.ts` | `api.execute@50 → 'postAgentTurnReceipt'` |
| `apps/body/src/turn-stream.ts` | `api .execute@218 → 'postAgentDraft'`; `api .execute@290 → 'retractAgentLiveOutput'`; `api.execute@323 → 'postRoomMessage'` |
| `apps/mobile/sources/app/(app)/beeline/browser-share.tsx` | `monolithPhoneOperation@29 → 'openComputerSession'` |
| `apps/mobile/sources/app/(app)/beeline/chat/RepositoryOnboardingCard.tsx` | `monolithPhoneOperation@44 → 'actOnRepositoryCard'`; `monolithPhoneOperation@58 → 'actOnRepositoryCard'`; `monolithPhoneOperation@64 → 'actOnRepositoryCard'` |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx` | `monolithPhoneOperation@820 → 'updateRoomPushState'`; `monolithPhoneOperation@3585 → 'cancelAgentTurn'`; `monolithPhoneOperation@3795 → 'reactToMessage'`; `monolithPhoneOperation@3841 → 'setMessageBookmark'`; `monolithPhoneOperation@3869 → 'reportMessageIssue'`; `monolithPhoneOperation@3906 → 'deleteRoomMessage'`; `monolithPhoneOperation@3979 → 'sendRoomMessage'`; `monolithPhoneOperation@4553 → 'decideAgentGrant'`; `monolithPhoneOperation@4573 → 'answerChoice'`; `monolithPhoneOperation@4597 → 'skipChoice'`; `monolithPhoneOperation@4614 → 'createRoomPoll'`; `monolithPhoneOperation@4648 → 'acceptConnectorOffer'`; `monolithPhoneOperation@4668 → 'acceptConnectorOffer'`; `monolithPhoneOperation@5844 → 'beginAppSignIn'`; `monolithPhoneOperation@5874 → 'completeAgentSignIn'`; `monolithPhoneOperation@5900 → 'decideApprovalCard'`; `monolithPhoneOperation@5950 → 'decideApprovalCard'`; `monolithPhoneOperation@7372 → 'updateRoom'` |
| `apps/mobile/sources/app/(app)/beeline/community.tsx` | `monolithPhoneOperation@75 → 'createWorkspace'`; `monolithPhoneOperation@76 → 'updateWorkspace'` |
| `apps/mobile/sources/app/(app)/beeline/create-workspace.tsx` | `monolithPhoneOperation@73 → 'createWorkspace'`; `monolithPhoneOperation@78 → 'updateWorkspace'` |
| `apps/mobile/sources/app/(app)/beeline/github-installation.tsx` | `monolithPhoneOperation@44 → 'listGitHubRepositories'` |
| `apps/mobile/sources/app/(app)/beeline/human-profile.tsx` | `monolithPhoneOperation@220 → 'removeWorkspaceMember'`; `monolithPhoneOperation@269 → 'resolveDirectMessage'`; `monolithPhoneOperation@296 → 'addWorkspaceMember'`; `monolithPhoneOperation@429 → 'revokeAgentGrant'` |
| `apps/mobile/sources/app/(app)/beeline/members.tsx` | `monolithPhoneOperation@491 → 'readAgentProfile'`; `monolithPhoneOperation@957 → 'updateAgentYolo'`; `monolithPhoneOperation@985 → 'updateAgentAccessPolicy'`; `monolithPhoneOperation@1076 → 'refreshAgentUsage'`; `monolithPhoneOperation@1103 → 'updateAgentWake'` |
| `apps/mobile/sources/app/(app)/beeline/onboarding.tsx` | `monolithPhoneOperation@523 → 'claimManagedHandle'` |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx` | `monolithPhoneOperation@155 → 'getManagedIdentity'`; `monolithPhoneOperation@174 → 'getManagedIdentity'`; `monolithPhoneOperation@189 → 'beginGitHubInstallation'`; `monolithPhoneOperation@193 → 'listGitHubRepositories'`; `monolithPhoneOperation@194 → 'getManagedIdentity'`; `monolithPhoneOperation@377 → 'updateIdentityPushLevel'`; `monolithPhoneOperation@586 → 'updateIdentitySpeakingSpeed'`; `monolithPhoneOperation@741 → 'updateIdentityFace'` |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connect-signin.tsx` | `monolithPhoneOperation@130 → 'acceptConnectorOffer'` |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connect.tsx` | `monolithPhoneOperation@239 → 'acceptConnectorOffer'` |
| `apps/mobile/sources/app/(app)/beeline/settings/workflows.tsx` | `monolithPhoneOperation@61 → 'listRoomWorkflows'`; `monolithPhoneOperation@91 → 'dispatchRoomWorkflow'` |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx` | `monolithPhoneOperation@446 → 'clearNeedsYou'`; `monolithPhoneOperation@488 → 'decideAgentGrant'`; `monolithPhoneOperation@491 → 'decideWritePermission'`; `monolithPhoneOperation@496 → 'answerChoice'`; `monolithPhoneOperation@499 → 'skipChoice'`; `monolithPhoneOperation@537 → 'clearNeedsYouSection'`; `monolithPhoneOperation@547 → 'clearMessageBookmarks'`; `monolithPhoneOperation@663 → 'setMessageBookmark'`; `monolithPhoneOperation@695 → 'setMessageBookmark'` |
| `apps/mobile/sources/app/(app)/beeline/workflow-run.tsx` | `monolithPhoneOperation@66 → 'readWorkflowRun'` |
| `apps/mobile/sources/app/(app)/beeline/workflow.tsx` | `monolithPhoneOperation@44 → 'readWorkflowDefinition'` |
| `apps/mobile/sources/app/(app)/join/[token].tsx` | `monolithPhoneOperation@97 → 'redeemInvite'`; `monolithPhoneOperation@129 → 'redeemInvite'` |
| `apps/mobile/sources/buzz/client-error-report.ts` | `sharedLiveConnection().request@53 → 'reportClientError'` |
| `apps/mobile/sources/buzz/managed-identity-surface.ts` | `monolithPhoneOperation@44 → 'getManagedIdentity'`; `monolithPhoneOperation@78 → 'readIdentitySettings'` |
| `apps/mobile/sources/buzz/needs-you-store.ts` | `monolithPhoneOperation@166 → 'readNeedsYou'`; `monolithPhoneOperation@185 → 'listMessageBookmarks'`; `monolithPhoneOperation@209 → 'readTray'`; `monolithPhoneOperation@406 → 'markNeedsYouSeen'` |
| `apps/mobile/sources/buzz/onboarding-rollout.ts` | `monolithPhoneOperation@7 → 'getAuthCapabilities'` |
| `apps/mobile/sources/buzz/room-page-observation.ts` | `sharedLiveConnection().request@10 → 'reportPageLoad'` |
| `apps/mobile/sources/buzz/scheduled-work.ts` | `monolithPhoneOperation@200 → 'readScheduledWork'`; `monolithPhoneOperation@221 → 'readScheduledWork'`; `monolithPhoneOperation@263 → 'deleteRoomSchedule'`; `monolithPhoneOperation@278 → 'deleteRoomSubscription'` |
| `apps/mobile/sources/buzz/use-room-workflow-run.ts` | `monolithPhoneOperation@73 → 'listRoomWorkflowRuns'` |
| `apps/mobile/sources/buzz/wallet-source.ts` | `monolithPhoneOperation@43 → 'createWallet'`; `monolithPhoneOperation@47 → 'readWallet'`; `monolithPhoneOperation@57 → 'sendFromWallet'`; `monolithPhoneOperation@61 → 'grantWalletDelegation'`; `monolithPhoneOperation@67 → 'revokeWalletDelegation'`; `monolithPhoneOperation@71 → 'readWalletHistory'` |
| `apps/mobile/sources/buzz/workbench-source.ts` | `monolithPhoneOperation@172 → 'readConnectApp'`; `monolithPhoneOperation@181 → 'searchWorkbenchApps'`; `monolithPhoneOperation@184 → 'beginLinkSignIn'`; `monolithPhoneOperation@188 → 'cancelLinkSignIn'`; `monolithPhoneOperation@192 → 'disconnectLinkSignIn'`; `monolithPhoneOperation@200 → 'readWorkbench'`; `monolithPhoneOperation@321 → 'pairConnector'`; `monolithPhoneOperation@330 → 'cancelGoogleSignIn'`; `monolithPhoneOperation@335 → 'beginGoogleSignIn'`; `monolithPhoneOperation@343 → 'readGoogleSignIn'`; `monolithPhoneOperation@349 → 'readConnectorInstall'`; `monolithPhoneOperation@374 → 'readConnectionDetail'`; `monolithPhoneOperation@407 → 'revokeConnectionGrants'`; `monolithPhoneOperation@419 → 'unpairConnector'`; `monolithPhoneOperation@422 → 'readWorkbench'`; `monolithPhoneOperation@426 → 'disconnectGoogleSignIn'`; `monolithPhoneOperation@435 → 'unpairConnector'`; `monolithPhoneOperation@450 → 'connectWorkbenchApp'`; `monolithPhoneOperation@463 → 'beginAppSignIn'`; `monolithPhoneOperation@467 → 'completeAppSignIn'`; `monolithPhoneOperation@471 → 'disconnectWorkbenchApp'` |
| `apps/mobile/sources/components/DesktopRoomInspector.tsx` | `monolithPhoneOperation@380 → 'cancelAgentTurn'` |
| `apps/mobile/sources/components/buzz/AiClientsSection.tsx` | `monolithPhoneOperation@26 → 'disconnectAiClient'` |
| `apps/mobile/sources/components/buzz/ComputerSession.tsx` | `monolithPhoneOperation@180 → 'openComputerSession'`; `monolithPhoneOperation@202 → 'openComputerSession'`; `monolithPhoneOperation@250 → 'openComputerSession'`; `monolithPhoneOperation@320 → 'openComputerSession'`; `monolithPhoneOperation@340 → 'openComputerSession'` |
| `apps/mobile/sources/components/buzz/StarPromptCard.tsx` | `monolithPhoneOperation@41 → 'readStarPrompt'`; `monolithPhoneOperation@75 → 'answerStarPrompt'` |
| `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx` | `monolithPhoneOperation@179 → 'createInvite'`; `monolithPhoneOperation@386 → 'updateRoom'`; `monolithPhoneOperation@406 → 'addRoomMember'`; `monolithPhoneOperation@437 → 'deleteWorkspace'`; `monolithPhoneOperation@581 → 'updateWorkspace'` |
| `apps/mobile/sources/push/buzz-push-registration.ts` | `monolithPhoneOperation@298 → 'registerPushDevice'`; `monolithPhoneOperation@337 → 'sendPushTest'`; `monolithPhoneOperation@406 → 'unregisterPushDevice'` |
| `apps/mobile/sources/push/notification-action-runtime.ts` | `monolithPhoneOperation@66 → 'decideAgentGrant'`; `monolithPhoneOperation@68 → 'sendRoomReply'` |
| `apps/mobile/sources/push/update-receipt.ts` | `monolithPhoneOperation@81 → 'reportRunningUpdate'` |
| `apps/mobile/sources/push/web-push-registration.ts` | `monolithPhoneOperation@58 → 'unregisterPushDevice'`; `monolithPhoneOperation@84 → 'readWebPushKey'`; `monolithPhoneOperation@112 → 'registerPushDevice'` |
| `apps/mobile/sources/sync/transport/monolith-rig-transport.ts` | `this.transport.operation@130 → 'createWorkspace'`; `this.transport.operation@150 → 'updateRoom'`; `this.transport.operation@153 → 'updateRoom'`; `this.transport.operation@156 → 'updateWorkspace'`; `this.transport.operation@159 → 'updateWorkspace'`; `this.transport.operation@162 → 'updateWorkspace'`; `this.transport.operation@165 → 'createInvite'`; `this.transport.operation@168 → 'createAgentPairingCode'`; `this.transport.operation@171 → 'addWorkspaceMember'`; `this.transport.operation@181 → 'updateAgentSoul'`; `this.transport.operation@191 → 'updateAgentModelSelection'`; `this.transport.operation@198 → 'refreshAgentModelCatalog'`; `this.transport.operation@201 → 'removeAgent'`; `this.transport.operation@205 → 'removeWorkspaceMember'`; `this.transport.operation@208 → 'getManagedIdentity'`; `this.transport.operation@227 → 'updatePersonProfile'`; `this.operation@264 → 'createRoom'`; `this.operation@389 → 'decideWritePermission'`; `this.operation@399 → 'addRoomMember'`; `this.operation@407 → 'addRoomMember'`; `this.operation@413 → 'removeRoomMember'`; `this.operation@416 → 'leaveRoom'`; `this.operation@422 → 'closeChat'`; `this.operation@425 → 'reopenChat'`; `this.operation@428 → 'deleteRoom'`; `this.operation@431 → 'leaveWorkspace'`; `this.operation@436 → 'deleteAccount'`; `this.operation@439 → 'resolveDirectMessage'`; `this.operation@445 → 'setCornerLocked'`; `this.operation@448 → 'requestCornerClose'`; `this.operation@459 → 'createHumanCorner'`; `this.operation@472 → 'setRoomRepository'`; `this.operation@482 → 'setRoomTargetBranch'`; `this.operation@489 → 'removeRoomRepository'`; `this.operation@492 → 'listGitHubRepositories'`; `this.operation@532 → 'beginGitHubInstallation'`; `this.operation@543 → 'createGitHubRepository'`; `this.operation@560 → 'getGitHubRepositoryAccess'` |

### Computed generic candidates

| Exact source | Calls (`expression@line → argument`) |
| --- | --- |
| `apps/body/src/command-fixture.test-support.ts` | `target.execute@110 → name`; `target.execute@113 → name` |
| `apps/body/src/server-command-intake.ts` | `target.execute@86 → name` |
| `apps/mobile/sources/app/(app)/beeline/settings/subscription.tsx` | `monolithPhoneOperation@60 → rotate ? 'rotateWebhookToken' : 'revealWebhookToken'` |
| `apps/mobile/sources/buzz/router-owner.ts` | `next.execute@265 → request` |
| `apps/mobile/sources/sync/transport/monolith-operation.ts` | `sharedLiveConnection().request@116 → name`; `sharedLiveConnection().request@123 → name` |
| `apps/mobile/sources/sync/transport/monolith-rig-transport.ts` | `monolithPhoneOperation@279 → name as keyof import('@beeline/api-contract/phone').PhoneOperationMap`; `this.operation@340 → operation` |
| `apps/mobile/sources/sync/transport/room-view-client.ts` | `sharedLiveConnection().request@149 → name` |

