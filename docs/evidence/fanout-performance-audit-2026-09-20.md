# Fanout and client performance audit — extension

Date: 2026-09-20
Author: Niglet
Extends: [`fanout-performance-audit-2026-09-18.md`](./fanout-performance-audit-2026-09-18.md)
Scope: the two product targets the first audit returned unproven (150 ms live
interaction, 450 ms page load), plus every phone GET surface it had not swept.

## Status

**Extended by
[`fanout-performance-audit-2026-09-22.md`](./fanout-performance-audit-2026-09-22.md),**
which measures the scroll interaction after #1609 put a server write behind it
and adds G6 and G7 to the ranking below. Nothing there displaces G1–G5.

**Both gaps are now numbers rather than estimates.**

- **450 ms page load — met on the server and transport half.** A cold 200-Room
  deck answers in 26.1 ms p95 and a Room carrying 5,000 messages in 29.4 ms p95,
  contract guard included. That leaves roughly 420 ms of the budget for native
  render. Native layout and GPU work on a device is still not measured; see
  [Not covered](#not-covered).
- **150 ms live interaction — met on the open Room, missed on the deck.** An open
  Room paints a committed message 33.2 ms p95 after the write leaves the writer.
  A deck whose last refresh is older than the coalescing floor refreshes in
  52.1 ms p95. A deck that gets an event *inside* the floor waits 504.9 ms p95 —
  and all of that overage is the floor, not work.

The first audit estimated the miss path at ~662 ms composed from three constants.
Measured, it is 504.9 ms, and the composition is simpler than the estimate: the
reader waits out the remainder of the 500 ms `SurfaceRefreshScheduler` floor and
then does ~6 ms of work. The deadline constant does not appear in the wait at all.

## How this was measured

`apps/server/src/live-interaction-latency.test.ts` and
`apps/server/src/live-fanout-sweep.test.ts`. Everything below the client's render
call is real: released HTTP routes, released WebSocket fanout, `PhoneService`
against a seeded corpus, the same response guards the phone validates with, and
the client's own `SurfaceRefreshScheduler` at its shipped defaults. Tokens are
minted through the released sign-in exchange.

Corpus: one Workspace, 200 Rooms (the width `readChats` caps at), 5,000 messages
in the measured Room, 40 corners under it, a 503-member roster, and one agent.
15 samples per path.

The table below is one recorded run (`npx vitest run src/live-interaction-latency.test.ts
src/live-fanout-sweep.test.ts` in `apps/server`, 2026-09-20). The store is PGlite,
so absolute milliseconds move a few either way between runs; the assertions are
written against the targets, not against these figures, and the deck-in-floor
row is asserted to sit inside the floor rather than under the target.

## Measured

| Path | p50 | p95 | Target | Verdict |
| --- | ---: | ---: | ---: | --- |
| interaction.open-room | 17.1 ms | 33.2 ms | 150 ms | met |
| interaction.deck-quiet | 42.0 ms | 52.1 ms | 150 ms | met |
| interaction.deck-in-floor | 500.5 ms | 504.9 ms | 150 ms | **missed** |
| page-load.deck | 24.0 ms | 26.1 ms | 450 ms | met |
| page-load.room | 25.7 ms | 29.4 ms | 450 ms | met |
| surface.workspaces | 4.1 ms | 5.4 ms | 500 ms | met |
| surface.workspace | 8.7 ms | 10.4 ms | 500 ms | met |
| surface.members | 7.6 ms | 10.6 ms | 500 ms | met |
| surface.members-deep-page | 8.2 ms | 10.7 ms | 500 ms | met |
| surface.members-search | 6.7 ms | 7.6 ms | 500 ms | met |
| surface.agent | 11.6 ms | 14.4 ms | 500 ms | met |
| surface.corners | 7.2 ms | 10.9 ms | 500 ms | met |
| surface.history | 8.2 ms | 11.0 ms | 500 ms | met |
| surface.history-deep-page | 7.9 ms | 9.7 ms | 500 ms | met |

That is all eight authenticated phone GET routes in `server.ts`, each at the
width its own API allows, including the deep-page variants of the two that
paginate. No route is near its budget.

Write cost, counted statement by statement rather than reasoned about:

| Measurement | 1 unit | at width | Per unit |
| --- | ---: | ---: | ---: |
| Human message, attached readers | 9 statements (1 reader) | 16 statements (8 readers) | +1 statement/reader |
| Human message, tagged agents | 8 statements (0 mentions) | 35 statements (4 mentions) | +6.75 statements/mention |

## Ranking

| Rank | ID | Severity | Finding |
| --- | --- | --- | --- |
| 1 | G1 | P1 | Deck interaction misses 150 ms on the coalescing floor, not on work |
| 2 | G2 | P2 | Mention routing runs serially inside the send transaction |
| 3 | G3 | P2 | Every attached reader adds a Room read to every human message |
| 4 | G4 | P3 | Agent profile read scans the whole Workspace roster |

### G1 — The deck waits on the floor, not on the work (P1)

`interaction.deck-in-floor` is 504.9 ms p95 against a 150 ms target. The same
deck, asked the same question when it is not inside the floor, answers in
52.1 ms p95. The work has ~98 ms of headroom under the target; the floor spends
500 ms of it.

This is the whole of the remaining P1, and it means the fix is not a faster
query. The deck refreshes on every live event, so in any Workspace with ongoing
traffic the next event almost always lands inside the floor, and the reader pays
the remainder of it.

Two directions, both of which leave the floor intact for the case it exists for
(capping a busy Workspace near two physical GETs/s so it cannot flood the
10-slot app pool):

- Have the deck apply a committed row delta the way the open Room already does,
  instead of marking itself dirty and refetching the whole deck. The open Room
  path measures 33.2 ms p95 doing exactly this.
- Or let a delta that names a single Room bypass the floor, since it costs one
  row rather than a 200-Room deck read.

Ranked first: it is the only measured miss against a product target, and it is
on the surface every phone opens.

### G2 — Mention routing is serial inside the send transaction (P2)

Four tagged agents take a message from 8 statements to 35 — 6.75 statements per
mention. `routeHumanMention` reads eligibility and creates the command one agent
at a time, and it does so inside the send transaction.

Ranked above G3 despite being rarer, because the cost is held inside a write
transaction. That serializes other writers to the Room for the duration, so the
damage is contention rather than CPU alone, and it grows with the number of
agents tagged in one message.

### G3 — One extra Room read per attached reader, per human message (P2)

Eight attached readers cost 16 statements against one reader's 9: one extra
statement per reader, linear in attachment. A phone write publishes an id-only
invalidation, so each socket resolves the row for itself.

The agent reply path already commits a row delta, which would make this zero.
Ranked below G2 because the statements are outside a transaction and cheap
individually, but it touches every human message in every Room, so it is the
broadest of the four.

### G4 — Agent profile read is linear in roster width (P3)

`surface.agent` is the slowest swept surface at 14.4 ms p95. `readAgent` calls
`members(workspaceId, null)`, which selects every Workspace membership with no
`LIMIT` and runs a lateral presence read per member, and then finds one agent in
the result.

At 503 members this is 14 ms, well inside budget, so it is P3 today. It is
listed because its cost is linear in roster size while the members *list* route
was bounded at the query in #1502 — the detail route kept the unbounded path.

## What the first audit got right and wrong

- **F5 was a fair complaint and is now half answered.** The server and transport
  half of the 450 ms budget costs under 30 ms. The first audit could not say that.
- **The ~662 ms P1 estimate was too high and composed from the wrong parts.**
  The real figure is 504.9 ms, it is the floor plus a few milliseconds, and the
  150 ms live-delta deadline constant never enters the reader's wait.
- **"Restoring the 500 ms floor does not meet the product interaction target"
  holds.** It does not, and now there is a number for by how much.

## Not covered

- Native React Native layout and GPU work on a device. The 450 ms verdict above
  is for everything up to the client's render call. Closing the remainder needs
  an on-device paint measurement, which is the part of F5 that stays open.
- The cross-machine PostgreSQL `LISTEN` hop. Readers here are attached to the
  writing machine.
- Write throughput under concurrent writers. Every measurement above is one
  writer at a time.

## Out of scope

No product code behavior was changed. G1–G4 are ranked for follow-up corners,
not implemented here.
