# Network router ownership

The closed operation dispatch table is `packages/net/src/routes.ts`. Generated wire shapes in that package and `packages/api-contract` preserve installed-client compatibility. Phone requests use `apps/mobile/sources/sync/transport/live-connection.ts`; helper traffic uses the existing machine connection in `apps/body/src/machine-link.ts`. A capability handshake describes the peer's installed protocol, storage and source guarantees. It does not select a rollout cohort or enable an alternate phone reader.

`apps/mobile/network-channels.json` and `scripts/check-phone-network-channels.mjs` inventory the remaining platform and file-byte exceptions. `packages/net/migration-sites.json` and `scripts/check-router-boundaries.mjs` ratchet the wider network inventory. A manifest entry cannot authorize a second socket owner. Existing voice, browser-share and computer-session media adapters retain their scoped transports; they do not carry phone/helper control operations.

## Local checks retained

Wire shape parsing belongs to the generated dispatcher codecs. The local admission owner no longer parses those shapes, validates Saved cursor syntax, or prepares a second message intent. Normal message sends retain the existing prepared event ID and durable outbox.

The following checks remain in `packages/net/src/private/admission.ts` because the server and wire codec cannot enforce these local rules:

| Check | Reason it remains |
| --- | --- |
| Owner identity, session epoch and canonical operation/input key | A local pass must not move between accounts, operations or targets. Server authorization alone cannot bind a local deferred callback to its originating session. |
| Unforgeable pass and atomic single spend | Prevent repeated effects or fabricated feature callbacks from dispatching the same local opportunity twice. |
| Foreground and lifetime revocation | Stop private reads and late completions after blur, background or reset. These UI transitions are not server facts. |
| Navigation generation and stable owner signature | React attachment and repeated rendering cannot manufacture a new read. A changed route owns a new generation. |
| Screen/family and action/operation binding | A visible badge, Room, Tray, agent profile or user gesture can demand only its own declared operations. Shape validity does not establish user intent. |
| Recovery generation | Admit at most one recovery batch for an actual negotiated connection; errors and elapsed time cannot renew it. |
| Media focus, visible object set and residency budget | Only the displayed Room and its visible files or explicit file actions can demand metadata, links or playback. The server cannot observe a local viewport. |
| Usage profile generation | Only the committed profile or desktop profile pane owns its usage demand. |
| Tray paint IDs, per-residency deduplication and capacity | Mark only questions actually painted, once per residency, without a timer or a repeated command on rendering. |
| Saved continuation and explicit Retry lifetime/key binding | A continuation belongs to the focused Tray's current server DTO; Retry belongs to an existing lane. Neither attaching an observer nor a late callback creates an action. |
| Local owner/key/byte quotas and bounded diagnostics | Bound local retained authority and work; remote request size limits do not bound local residency state. |

Helper source epochs, current connection ownership, turn bindings and dispatch-time fences also remain. They prevent stale helpers from executing work or borrowing another turn's authority. Authentication, membership, permission checks, committed-source readiness and final enqueue fences remain with their existing server owners. Installed old helper/phone wire adapters are compatibility at the same dispatcher, rather than a second connection lifecycle.

## Room projection scope

The canonical `room-head` projection contains the newest 30 messages (`ROOM_VIEW_MESSAGE_LIMIT`). History windows continue to use the existing explicit history operations. Mutation responses update loaded message records. The existing negotiated router suppresses legacy durable message deltas; it does not currently deliver another reader's edits to historical rows outside that head. Removing the fallback preserves that existing router behavior. `useRoomSurfaceSession.test.ts` covers canonical head updates, local history mutation results, unread boundaries, Room reopening, presence and draft settlement.

## Cleanup regression evidence

The native comparison used the same release shell and cloned local databases on emulator-5628. Main retained `router90-send-repro`; the cleanup acknowledged and committed the send but returned to an empty transcript even though the canonical Room-head push contained the message. The canonical owner must classify contiguous Workspace intervals that leave a covered Room head unchanged, including the interval from reopening a chat, so the next message replacement can reach the Room consumer. `useRoomSurfaceSession.test.ts` exercises the real canonical owner, multipart push delivery, session rendering and outbox reconciliation across that boundary; `read-lanes.test.ts` also checks that a genuinely missing interval stays unbridged.

The driver's final comparison of main `5f78f1364` and integrated cleanup `964d34fa3` passed 5/5 delayed-snapshot, unrelated-Room-revocation and send-retention repetitions on each head. All ten durable sends were unique and retained their sent row; the revoked Room showed Access removed without its secret. The driver recorded `final-native-comparison.json` and `native-final-{main,branch}/` in its router-removal proof directory and restored the production APK v0.2.22/code 27. These are functional results supplied by the designated driver; subsequent candidate verification remains driver-owned.

The browser proof then exposed a preexisting release integration gap: both main `5f78f1364` and the cleanup registered Tray clock schemas but omitted the canonical Saved window, Saved source and mutable source schemas. A populated canonical Tray read after release migration failed because `message_bookmarks.bookmark_id` did not exist. Release migration now installs those existing schema owners, with Saved identities before Saved content/access capture. `tray-release-migration.test.ts` exercises populated canonical snapshots, clears, source capture and idempotent legacy upgrades through `migrate()` without privately installing Tray schemas. Browser bookmark, multi-tab recovery and current-head helper proofs remain with the driver.

No latency A/B was captured. The local main baseline failed Room-list readiness because the 200-Room fixture exceeded the existing 64 KiB phone snapshot bound, and the later baseline setup also failed. There are no p50/p95 results, and the initial native send smoke failed as described above. The final native 5/5 comparison establishes functional retention, not latency.
