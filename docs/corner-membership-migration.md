# Corner access without memberships

Corners have no stored membership rows, active or archived. Current parent Room membership authorizes access. Implementer and reviewer assignments belong to `corner_facts` and the parent's reviewer configuration. `corner_person_state` stores only explicit preferences; it cannot grant access after parent departure.

`room_access` is the read-only access projection used by generic surface readers. Its corner branch joins the current physical parent Room membership, overlays sparse preferences and excludes archived corners. It is not a second roster. The prior `effective_memberships` name remains only as a read-only alias for the preceding server image during deployment. Phone startup and sync never load archived access rows or subscribe to archived corners. Explicit archived transcript, paginated history, outlines, bookmarks and archived lists authorize through the parent Room; archived views return no live watch filters.

The helper's separate `getDaemonBootstrap.storageRooms` cleanup facts retain archived corner IDs through current parent Room membership. These facts create no memberships and are absent from active Room discovery and phone startup. Parent departure removes inherited cleanup facts too (`ARCHIVE-FACT-1` in `daemon-storage-lifecycle.test.ts`).

## Normal release migration

The schema creates `room_access`, removes both legacy preference synchronization triggers and installs `guard_corner_membership`. This guard rejects INSERTs and room-id changes targeting any corner. `migrateCornerPersonState` preserves non-default legacy preferences in batches of 250. `removeCornerMemberships` then deletes every physical corner membership in restartable batches of 250, including already-removed rows, for every identity. Repeating the release is safe. Rooms, corner facts, assignments, messages, owed items, attention, read marks, follows and history survive.

The former lazy compatibility writer is gone. Phone send/delete and voice answers authorize and lock the parent membership inside the existing message statement. Joins, corner creation, reviewer configuration, pairing and member changes never write corner memberships. The database guard also blocks the retired predecessor backfill. A rollback must retain the parent-authorized read/write implementation; restoring the old roster backfill is no longer a supported recovery action.

There is no unarchive command. Clearing `archived_at` restores projected access for current parent participants automatically, with no membership writes and no revival of departed participants.

The complete [reader and writer inventory](corner-access-audit.md) names every production query path, including schema-owned readers and the remaining top-level writers. Relevant regression coverage: `archived-corner-memberships.test.ts`, `corner-person-state.test.ts`, `corner-person-state.production.test.ts`, `corner-rollback.test.ts`, `phone-service.archived-corners.test.ts`, `corner-lifecycle.test.ts` and `system-message-catalog.test.ts`.

## Isolated owner-shaped proof

`scripts/prove-archived-corner-memberships.mjs` starts a loopback HTTP service against an isolated PostgreSQL engine. The generated account has 43 top-level Rooms, 11 active corners, 1,146 archived corners and 36 agents. The owner starts with 1,200 physical surface memberships; after the normal migration only the 43 top-level Room memberships remain (plus its Workspace membership). The same fixture posts into an active corner over authenticated HTTP, receives a real live socket invalidation, retains its implementer/reviewer assignments, and reads archived history. The script measures the three primary Room startup reads (`workspaces`, `workspace`, `chats`), Room-list response bytes, cold load time and seven warm samples. It never uses production data or starts a helper.

```sh
npm run build -w @beeline/server
node --import tsx scripts/prove-archived-corner-memberships.mjs
```

For comparison against the original source, export that revision's `apps/server/src` and `apps/server/assets` below `.beeline-proof/`, then pass `--source-root=<export>/apps/server/src`. The proof asserts no archived corner appears in any measured startup response. HTTP fixture timings do not establish Android rendering performance or the ANR's cause; those require the independent device investigation.

Measured on the synthetic fixture against base `41a4fcc50` (source baseline versus built server):

| Metric | Before | After |
| --- | ---: | ---: |
| Owner stored surface memberships | 1,200 | 43 |
| Physical membership projection | 61,201 B | 2,194 B |
| Three Room startup responses | 41,586 B | 41,586 B |
| Room-list response | 29,635 B | 29,635 B |
| Cold Room-list HTTP load | 224.89 ms | 104.92 ms |
| Median of seven warm Room-list loads | 201.15 ms | 92.71 ms |
| Archived corners in startup | 0 | 0 |

These are local fixture measurements, not device timings. The unchanged phone response size is deliberate evidence: the original Room list already excluded archived corners. The change removes durable roster rows and reduces server-side access work; it does not establish the Android ANR's cause.
