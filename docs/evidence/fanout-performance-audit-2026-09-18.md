# Fanout and client performance audit

Date: 2026-09-18  
Authors: Sol (initial), Nerd (independent verification + ranking + implementation)  
Scope: server live fanout, Room/deck hot reads, push delivery, client paint evidence  

## Status

Implementation landed on this branch for the reconciled priority list (subscription batching, listener-owned presence fanout, push concurrency, 200-Room width corpus with explainHotRead, multi-Room batch auth). Latency floors: live-delta deadline 150 ms (under the interaction target for the server wait alone); SurfaceRefreshScheduler stays at 500 ms (~2 GETs/s) so a busy Workspace cannot flood the app pool. The 150 ms e2e miss path is **not** claimed via coalesce-floor arithmetic — same-process force stays immediate, and GET+paint is measured by the client paint benchmark (F5).

## Targets (source of truth for this audit)

| Target | Value |
| --- | --- |
| Hot-read p95 | 100–250 ms (`HOT_READ_BUDGETS_MS`: room-view 250; room-list / history / live-delta / presence / push / corners 100) |
| Route p95 | 500 ms |
| Route p99 | 1,000 ms |
| Route maximum | 2,000 ms |
| Live interaction target (miss path) | 150 ms end-to-end product goal (not closed by coalesce floors while scheduler is pool-safe) |
| Live-delta fallback deadline | 150 ms (`LIVE_DELTA_DEADLINE_MS` = interaction target in `apps/server/src/server.ts`; was 400) |
| Surface refresh floor | 500 ms (`SurfaceRefreshScheduler` default `minimumIntervalMs`; pool-safe ~2 GETs/s) |

## Ranking (Nerd)

| Rank | ID | Severity | Verdict vs Sol |
| --- | --- | --- | --- |
| 1 | F1 Room-deck live subscribe miswire | P1 | **Confirm.** Keep above F2. |
| 2 | F2 Duplicate presence fanout on writer | P1 | **Confirm.** Still P1; lower than F1. |
| 3 | F3 Hot-read corpus lacks family width | P2 | **Confirm.** |
| 4 | F4 Push delivery serializes on sole leader | P2 | **Confirm.** |
| 5 | F5 Client paint evidence is relay-era | P2 | **Confirm.** |

### Why subscription batching outranks duplicate presence fanout

F1 is both a **correctness** failure and a **pool** failure on the phone path every client uses:

- Cold deck (no chat cache) subscribes with `#h: [workspaceId]`. That is not a Room id. `canReadRoom` refuses it, so no live invalidation lands until the 30 s poll in `MonolithRigTransport.surfaceSubscribe`.
- Warm/cached deck can send one `subscribe` frame per Room id from `watchFilters` (API truncates at 200). Each frame runs its own `canReadRoom` against the 10-slot app pool.
- After `http.chats()` returns real Room ids, `channels.tsx` never reinstalls the watch. Contrast: `useRoomSurfaceSession` reinstalls when `watchFilters` change.

F2 doubles membership fanout on the **writing** server for every evidence write, and `LiveHub.publish` does not drop equal online presence versions. That burns CPU/DB and duplicates events, but clients still receive presence — they do not sit stale for 30 s. Cross-machine fanout already goes through the listener alone; the bug is writer-local double work plus missing exact-version dedupe.

Therefore: fix F1 first (one workspace- or batch-scoped subscribe + one auth read, and reinstall after chats load). Fix F2 next (listener-only fanout or exact presence-version dedupe in `LiveHub`).

## Finding detail

### F1 — Room-deck live updates miswired (P1)

Evidence:

- `apps/mobile/sources/app/(app)/beeline/channels.tsx` — cold filter uses `selectedId` (Workspace UUID) as `#h`; subscribe is installed once and not replaced after `chatsRefresh.apply`.
- `apps/mobile/sources/sync/transport/monolith-rig-transport.ts` — one WebSocket `subscribe` per room id; 30 s poll fallback.
- `apps/server/src/server.ts` — each `subscribe` awaits `phone.canReadRoom(roomId, …)` before attaching.
- `apps/server/src/phone-service.ts` `readChats` — returns `watchFilters` with up to 201 Room ids (`LIMIT 201`).

Optimize toward: one workspace/batched subscription and one authorization read; reinstall or seed filters from the chats response the same way Room surfaces do.

### F2 — Presence fanout duplicated on the writing server (P1)

Evidence:

- `connection-presence.ts` comments say the PostgreSQL listener expands one notification, then still calls `broadcastAgentPresence` after writes (`recordAgentEvidence`, lifecycle paths).
- `postgres-live.ts` re-runs the membership query and publishes presence on `kind === 'presence'`.
- `live.ts` only suppresses presence when `previous.observedAt > event.observedAt` or same timestamp with previous `offline` — equal online versions re-emit.

Optimize toward: listener as sole fanout authority, or dedupe exact presence versions (agentId + observedAt + status) before emit.

### F3 — Room reads bounded by message count, not family width (P2)

Evidence:

- `topLevelRoomRows` aggregates every visible corner with per-corner lateral latest-message and latest-turn reads.
- `production-corpus-hot-reads.test.ts` seeds one Room + one corner for 35,100 messages.
- Room-list budget (100 ms) is exercised with that single-Room workspace despite a 200-Room API cap.

Follow-up on this branch: `production-corpus-width.test.ts` now seeds 200 Rooms (API-supported shape, shallow) and one Room with 40 corners, invokes `explainHotRead` + `assertHotRead`, and asserts warm `readChats` / `readRoom` under the real `HOT_READ_BUDGETS_MS` (no 5× slack).

### F4 — Push delivery serializes under the sole background leader (P2)

Evidence:

- `PushDeliveryLoop.runOnce` awaits claim → send → update for up to 100 candidates in a serial loop.
- `APNS_REQUEST_TIMEOUT_MS = 15_000` per send.
- `BackgroundLeader` cycle in `index.ts` runs push, then schedules, then choice expiry, then periodic media/maintenance on one lock holder.
- Nominal push interval is 5 s (`PUSH_DELIVERY_MIN_INTERVAL_MS`).

Use bounded delivery concurrency or a separate delivery lane.

### F5 — Client performance evidence is stale (P2)

Evidence:

- `apps/mobile/evidence/navigation-performance-api36.md` reports 306 / 430 / 486 ms paints against the public relay reader (2026-08-12).
- Current monolith client coverage includes structural `FRAME-BUDGET` tests (`surface-runtime.frame-budget.test.ts`), not monolith cold/warm Room-deck or transcript paint benchmarks.
- `monolith-paint-budgets.test.ts` measures in-process `PhoneService.readChats` / `readRoom` only — useful as a server hot-path floor, not as client cold/warm paint proof.

Follow-up on this branch: `monolith-client-paint-budgets.test.ts` measures cold/warm Room-deck (200 Rooms) and transcript (30 messages) through `RoomViewClient` transport+guard, JSON cache hydration, `SurfaceRefreshScheduler` apply, and the phone's `room-list-row` / `room-view-presentation` paint path under 450 ms, and prints measured GET+paint separately from the pool-safe 500 ms scheduler floor.

## Challenges / nuances (Nerd)

1. Sol’s F1 “never replaces” is accurate for the **deck** (`channels.tsx`). It is **not** true for Room transcript (`useRoomSurfaceSession` reinstalls watches). Keep the finding scoped to the deck.
2. Cached 200-frame burst requires a populated chat cache with `watchFilters`; cold-without-cache is the opposite failure mode (zero useful live subs until poll). Both are F1.
3. F2’s duplicate path is writer-local; peer machines only see the NOTIFY path. Severity remains P1 because every daemon evidence write hits the writer.
4. No runtime hot-read timings were re-measured in this corner (writable Vitest cache / workspace `dist` not available for a full corpus run). Ranking rests on structural path evidence plus the existing budget constants; F3/F5 explicitly call for better measurement before rewrite work.

## Out of scope

Product code changes, subscription protocol design, query rewrites, push concurrency implementation, and new client benchmarks — deferred to follow-up corners after this ranking is accepted.
