# Fanout and client performance audit — on-glass measurement

Date: 2026-09-22
Author: Niglet
Extends: [`fanout-performance-audit-2026-09-18.md`](./fanout-performance-audit-2026-09-18.md)
Scope: close the two gaps the 09-18 audit returned open — the 150 ms live
interaction target and the 450 ms page-load target — on a real Android device
running Hermes, and re-rank.

## Status

**BOTH GAPS CLOSED.** Both targets are missed, both misses are now isolated to a
named line of code, and the ranking below is ordered by measured contribution.

| Target | Surface | Measured on glass | Verdict |
| --- | --- | --- | --- |
| 450 ms page load | Cold Room open, tap to painted message | **893 ms** p50 (881–1015, n=6) | **missed by 443 ms** |
| 450 ms page load | Warm Room open (surface cache hit) | **158 ms** p50 (157–161, n=5) | met |
| 150 ms interaction | Open Room, live message | **219, 238 ms** (n=2) | **missed by ~75 ms** |
| 150 ms interaction | Room deck, live message | **580, 644, 557 ms** (n=3) | **missed by ~430 ms** |

The 09-18 audit could not measure any of these because it had no authenticated
device. It does now — see [Rig](#rig).

## What the misses are

**Page load.** 537 ms of the 893 ms cold open is one server read, and almost all
of that read is one SQL sub-select that scans the Room's whole roster once per
message and compiles a regex per member. **G8** below.

**Interaction.** The deck pays the 500 ms `SurfaceRefreshScheduler` floor
(`packages/buzz-client/src/surface-refresh.ts:46`); the open Room bypasses it
with a forced refresh and lands at ~230 ms. The 320–425 ms between the two
surfaces is the floor's remainder. **G1** below, previously unisolated, now
isolated on glass.

Removing either does not on its own meet its target. The deck without the floor
would land near the open Room's ~230 ms, still 80 ms over. The cold open without
G8 measured 452–493 ms, still 2–43 ms over.

## Rig

Everything below the client's render call is released code. Nothing is mocked.

- **Device.** `redroid-clubgg`, Android 11, x86_64, Hermes, **release** APK built
  from this branch with `EXPO_PUBLIC_ROOM_OPEN_TRACE=1`.
- **Sign-in.** The Play review link (`beeline://review/<secret>`), the released
  `POST /v1/auth/review/exchange` path. No GitHub OAuth, which is what blocked
  every earlier attempt at an authenticated device.
- **Server.** `createBeelineServer` with the real `PhoneService`, `LiveHub`,
  `PostgresLiveListener` and `ReviewAccess`, against **PostgreSQL 17** holding
  the audit corpus: 243 Rooms, 5,265 messages, 5,066 of them in the measured
  Room, 501 identities.
- **Transport.** The server runs inside the device's own network namespace, so
  the phone reaches it at `127.0.0.1:8099`.

### What this rig understates

- **Zero network latency.** Every figure here is a floor. A real network adds to
  all of them.
- **Host contention.** Load average was 20–29 throughout. Absolute milliseconds
  are noisy. The controlled comparisons (roster 501 vs 1; deck vs open Room) are
  not — each pair ran back to back under the same load.
- **15 Hz panel.** The device reports a 66.67 ms vsync period, so its own
  `Janky frames` verdict is against that budget and does **not** transfer to a
  60 Hz phone. Raw frame durations do.
- **iOS untouched.**

## Page load, phase by phase

`markRoomOpen` traces, medians of six cold opens (`pm clear` → review sign-in →
tap the Room). Elapsed from `nav-dispatch`.

| Phase | ms elapsed | Δ |
| --- | ---: | ---: |
| `nav-dispatch` | 0 | |
| `route-mount` | 38 | 38 |
| `identity-ready` | 55 | 15 |
| `cache-read-end` (miss) | 55 | 0 |
| `occupancy-yield-end` | 136 | **80** |
| `auth-ready` | 136 | 0 |
| `watch-ready` | 137 | 1 |
| `room-read-start` | 201 | 64 |
| `room-read-end` | 738 | **537** |
| `fresh-apply` | 740 | 2 |
| `layout-chrome` | 839 | 99 |
| `newest-frame` | **893** | 54 |

Read weight at `newest-frame`: 30 messages, 200 members, 83,557 bytes.

### The controlled experiment

Same device, same build, same Room, same 5,066-message transcript. Only the
Room's roster changed.

| Room roster | cold tap-to-paint | of which, Room read |
| ---: | ---: | ---: |
| 501 | 881, 881, 892, 895, 899, 1015 ms | 536–538 ms |
| 1 | 480, 452, 493 ms | 69, 69, 80 ms |

**The roster costs 413 ms of tap-to-paint** on a Room whose transcript did not
change.

## G8 — the mention scan (new, P1)

`PhoneService.topLevelRoomRows` awaits three concurrent enrichments before it
returns. One of them, `message-tags`, runs `taggedIdentityIdsSql` over the
30-message window:

```
apps/server/src/phone-service.ts:1773   optionalEnrichment('message-tags', …)
apps/server/src/message-mentions.ts     taggedIdentityIdsSql
```

Postgres `log_min_duration_statement` caught it directly:

```
LOG:  duration: 480.416 ms  execute <unnamed>: SELECT m.id,ARRAY(
        SELECT tagged_member.identity_id FROM memberships tagged_member
        JOIN identities tagged ON tagged.id=tagged_member.identity_id
        WHERE … AND m.text ~ ('(^|[^[:alnum:]_.-])@' ||
          regexp_replace(btrim(ltrim(tagged.handle,'@')),'([.-])','\&','g') ||
          '[.-]*($|[^[:alnum:]_.-])') …
      ) tagged_ids FROM messages m WHERE m.id=ANY($1::text[])
```

`EXPLAIN (ANALYZE, BUFFERS)` names the node:

```
SubPlan 1
  ->  Nested Loop Anti Join  (actual time=25.169..25.169 rows=0 loops=30)
        ->  Bitmap Heap Scan on memberships tagged_member  (rows=500 loops=30)
        ->  Materialize  (loops=15000)
              ->  Seq Scan on identities tagged  (actual time=24.824 loops=30)
                    Filter: (… AND m.text ~ (… handle …))
                    Rows Removed by Filter: 501
```

The regex is built from the **member's handle**, so it cannot be hoisted out of
the scan: Postgres compiles and runs one regex per member per message.
**30 × 501 = 15,030 regex evaluations on every Room open.** The planner's
`rows=3` / `rows=2` estimates are off by ~100×, which is why it picks the nested
loop.

Route timings, `GET /v1/phone/rooms/:id`, five runs each after a warm-up:

| Room roster | response bytes | p50 |
| ---: | ---: | ---: |
| 1 | 17,837 | 37 ms |
| 25 | 23,291 | 509 ms |
| 100 | 40,391 | 573 ms |
| 250 | 66,741 | 537 ms |
| 501 | 83,558 | 581 ms |

It is a step, not a slope: **25 members already costs 509 ms**, and it barely
grows after that. Any Room with more than a handful of members pays it, and
`spans` attributes all of it to `data`:

```
[slow-operation] {"operation":"phone.read_room","durationMs":577,
                  "spans":{"data":577,"media":0,"projection":0}}
```

**Fix direction** (not implemented here): invert the loop. Extract the `@handle`
tokens from the 30 message texts once — one `regexp_matches` per message, 30
total — then resolve those handles against the roster with an indexed lookup.
That replaces 15,030 regex evaluations with 30.

## G1 — the deck floor (isolated on glass)

Screen recordings (`screenrecord --bugreport`, per-frame millisecond overlay).
`sent` is when `POST /v1/phone/operations/sendRoomMessage` was issued from
another identity; `painted` is the first recorded frame showing the message.

| Surface | sent | painted | latency |
| --- | --- | --- | ---: |
| Open Room | 02:08:55.361 | 02:08:55.580 | **219 ms** |
| Open Room | 02:12:11.675 | 02:12:11.913 | **238 ms** |
| Deck | 02:10:01.329 | 02:10:01.909 | **580 ms** |
| Deck | 02:10:38.209 | 02:10:38.853 | **644 ms** |
| Deck | 02:11:19.156 | 02:11:19.713 | **557 ms** |

The previous recorded frame in each run is 1.2–3.8 s earlier — the screen is
static until the update, so the painted frame is the update, not a coincidence.

The deck sits 320–425 ms above the open Room on the same device, same server,
same message shape. `SurfaceRefreshScheduler` waits out the remainder of its
500 ms floor for a surface that only signals; a forced refresh bypasses it. The
09-18 audit's estimate that the floor, not query work, is what costs the deck
its target is confirmed on glass, with ~80 ms of paint on top.

## The read cursor on Hermes

`#1609` moved the read mark onto the transcript's viewability pass, so scroll can
now originate a server write. Earlier measurement of that path was node/V8 only.
`dumpsys gfxinfo` during sustained scroll of the 5,066-message Room:

| Run | frames | p50 | p90 | p95 | p99 | Slow UI thread | Missed vsync |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30-message window | 99 | 5 ms | 6 ms | 7 ms | 105 ms | 0 | 0 |
| after 3 history pages | 99 | 6 ms | 20 ms | 27 ms | 38 ms | 0 | 0 |

No sustained UI-thread stall. Against a 60 Hz budget the second run's 27 ms p95
would jank, but that run also paginated history mid-scroll, and this panel is
15 Hz so the device cannot arbitrate. **Scroll on glass never reached the 5,000
loaded rows the V8 measurement modelled** — three history pages is as deep as the
list got. G6 stays ranked on the V8 evidence, not on this.

## G9 — the enrichment deadline (new, P3)

`OPTIONAL_ENRICHMENT_DEADLINE_MS = 1_000` (`apps/server/src/phone-service.ts:168`)
is the guard that degrades a slow enrichment rather than blocking the read. It
sits at **more than twice the 450 ms page-load target**, so it cannot protect
that target: G8's 480–755 ms passes under it on every open and is always paid in
full.

## Ranking

| # | ID | Sev | Finding | Measured cost | Status |
| ---: | --- | --- | --- | --- | --- |
| 1 | **G8** | **P1** | `message-tags` enrichment runs 30 × roster regex evaluations per Room open | **413 ms** of the 443 ms page-load miss | **new** |
| 2 | G1 | P1 | Deck live update waits out the 500 ms `SurfaceRefreshScheduler` floor | **320–425 ms** of the ~430 ms deck interaction miss | **isolated on glass** |
| 3 | G5 | P2 | Cold first Room open over budget | 893 ms vs 450 ms; G8 is 413 ms of it | **re-baselined** |
| 4 | G2 | P2 | `routeHumanMention` serial inside the send transaction | 6.75 statements per mention | unchanged |
| 5 | G3 | P2 | One extra Room read per attached reader per human message | 1 statement per reader | unchanged |
| 6 | G4 | P3 | `readAgent` scans the unbounded Workspace roster | — | unchanged |
| 7 | G6 | P3 | `ReadCursorAdvancer.observe` is O(visible × transcript) on the scroll path | 0.4–0.7 ms p95 at 5,000 rows (V8) | unchanged |
| 8 | G7 | P3 | `markRead` spends 3 statements where 1 would do | 3 statements per scroll rest | unchanged |
| 9 | **G9** | **P3** | Optional-enrichment deadline (1,000 ms) sits above the 450 ms page-load target | guard never fires on G8 | **new** |

G8 is ranked first: it is the largest single measured contribution to either
target, it is one sub-select, and the Room does not have to be busy to pay it —
25 members is enough.

G1 keeps P1 because it is the only miss on the surface every phone opens first,
but it now ranks below G8 on measured milliseconds.

## Not closed

- **Neither target is met even with its top finding fixed.** G8 removed leaves a
  cold open at 452–493 ms against 450 ms; G1 removed leaves the deck near the
  open Room's ~230 ms against 150 ms. Both need a second round.
- **All client figures are a floor** — zero network latency, and a contended host.
- **iOS is unmeasured.**
- **Sample sizes are small** — n=6 cold opens, n=3 deck recordings, n=2 open-Room
  recordings. Enough to separate 893 from 480, or 580 from 230; not enough for a
  p95.
