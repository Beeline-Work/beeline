# Production import rehearsal — 2026-08-31

## Verdict

The data fits Neon Free after the audit log is excluded. The importer completed a clean import of the production snapshot, the server started, and a local send-then-read flow passed. The measured cut path was 88.155 seconds; snapshot extraction plus that cut path was 428.784 seconds (7 minutes 8.784 seconds), below the proposed 10–20 minute window.

Do **not** run the production cut yet. Live RoomView parity is not green: 0 of 7 comparable sampled responses matched, and four additional probes addressed rooms that no longer existed in the live reader. The differences include expected post-snapshot drift, but also stable projection gaps (corner sibling lists, inherited repository state, viewer/profile resolution, message projection, and watch filters). This rehearsal therefore proves importability, size, and timing, but not read parity.

## Safety and snapshot method

- PostgreSQL source: `buzz-router-prod-postgres-1`, custom-format `pg_dump`, with `default_transaction_read_only=on`, `SERIALIZABLE`, and `DEFERRABLE`. The final audit-excluded dump was 2,055,672,602 bytes and took 340.629 seconds.
- Push source: a read-only copy of `/var/lib/buzzy-push/registrations.json`, 17,180 bytes (4 registrations and 49 update receipts).
- MinIO source: read-only object listing and byte-for-byte mirror. The final inventory was 514 objects / 87,448,004 bytes.
- Production was not written, restarted, or locked. The relay, nginx, daemon fleet, and release pipeline were untouched.
- Import, parity reads, and the end-to-end write ran only against the disposable local PostgreSQL and local server.
- The production dumps and copied object bytes were deleted after the aggregate measurements below were recorded.

The dump restored into the local snapshot database in 311.317 seconds. Restore time is staging work and is not included in the cut-path number because the final importer reads the already-restored, consistent snapshot.

## Import result

The final clean import took 87 seconds and imported:

| Kind                           |                               Rows |
| ------------------------------ | ---------------------------------: |
| Identities                     |                              1,703 |
| Agents                         |                                486 |
| Workspaces                     |                                 53 |
| Rooms and corners              |                                875 |
| Memberships                    |                              4,241 |
| Source events considered       |                             11,900 |
| Latest presence records        |                                407 |
| Media objects (full rehearsal) |                                110 |
| Read marks                     |                                231 |
| Schedules                      | 6 kept / 3 stale-room rows dropped |

The importer defects found against production-shaped data were fixed in this PR:

- Identity and agent inserts are dependency-ordered. All identities, including missing referenced identities synthesized as placeholders, are inserted before any agent owner foreign key is exercised.
- Rooms are inserted with null parents, then parent links are restored after every room exists. The regression fixture deliberately puts both agent owners and child rooms before their parents and also proves interrupted-import resume.
- Production auth identity columns are normalized from text while relay keys remain bytea; relay tenant strings are no longer cast to UUID.
- Read marks and schedules for deleted rooms are omitted.
- Media URL matching is host-independent and rewrites both original and thumbnail URLs.
- Current presence, turn receipts, corner lifecycle facts, creator identity, hidden service identities, and production profile fields are carried into the monolith schema.

## Human messages and agent chatter

These are the normalized rows and `pg_column_size` logical bytes in the clean target before the local test message:

| Retained class                 |  Rows | Logical bytes |
| ------------------------------ | ----: | ------------: |
| Human messages                 | 4,274 |     3,958,448 |
| Agent conversation messages    |   952 |     1,436,272 |
| Agent-turn receipts            |    61 |        12,832 |
| Agent activity                 | 1,239 |     3,397,048 |
| Durable facts/cards            |     8 |        12,736 |
| Presence-adjacent latest state |   407 |        74,888 |
| Retired kinds                  |     0 |             0 |
| Other kept events              |    39 |        61,336 |

The production snapshot contained more append-only machine chatter than the normalized target retains:

| Raw source class       |  Rows | Source row bytes |
| ---------------------- | ----: | ---------------: |
| Agent-turn receipts    |    98 |           75,362 |
| Agent activity         | 1,250 |        5,470,082 |
| Presence               |   560 |          305,674 |
| Corner/GitHub facts    |    39 |           38,605 |
| Retired daemon notices |    86 |           66,820 |

The keep line is the user conversation plus the latest/paint-relevant machine state. Historical receipt and presence supersessions and all 86 retired notices stay dropped. The target's 61 receipts are the latest valid receipt per request, and its 407 presence rows are the latest valid agent/room records; stale presence is naturally removed by normal server maintenance after startup.

## Media

The 514-object MinIO inventory consists of 110 user-media objects / 87,334,236 bytes plus 404 repository, index, manifest, metadata, and probe objects / 113,768 bytes. The latter includes 79 explicit `probe/` objects / 4,183 bytes and is not monolith media.

| User-media class                   | Objects |   Source bytes |
| ---------------------------------- | ------: | -------------: |
| Referenced by kept messages        |      31 |      5,909,653 |
| Referenced only by current avatars |       4 |        849,391 |
| Unreferenced orphan                |      75 |     80,575,192 |
| **Total**                          | **110** | **87,334,236** |

Nine orphan `.bin` objects have near-identical roughly 8.7 MB sizes (77,994,546 bytes total), making them likely canary/test uploads. That is a shape-based inference, not provenance proof. The explicit `probe/` objects are proven tests but are auxiliary objects rather than user media.

Recommendation: import the 35 message/avatar-referenced objects (6,759,044 source bytes) and drop the 75 unreferenced objects. Preserve the full read-only inventory until the owner approves the cut policy so any disputed object can be reclassified. Do not delete anything from production as part of this recommendation.

## Neon storage

`npm run measure -w @beeline/server` measured physical PostgreSQL table-plus-index sizes:

| Import policy                     | Target bytes | Neon 500,000,000-byte ceiling |    Headroom |
| --------------------------------- | -----------: | ----------------------------: | ----------: |
| All 110 user-media objects        |   61,677,568 |                        12.34% | 438,322,432 |
| Recommended 35 referenced objects |   30,072,832 |                         6.01% | 469,927,168 |

The all-media target's largest relations were media (38,830,080 bytes), messages (11,657,216), import bookkeeping (6,897,664), memberships (1,654,784), and identities (573,440). The recommended-media rehearsal reduced the media relation to 7,176,192 bytes.

This is the evidence-backed reversal of the Phase A storage failure: the old audit log and orphan media, not the kept conversation, were the storage problem.

## RoomView parity oracle

The Phase B oracle made authenticated, read-only GETs to live RoomView and to the local monolith for three currently readable top-level rooms plus four old, closed corners. It normalized only media origins before hashing. Two additional runtime rooms and their corner-list calls returned live `404 not_found` and were recorded as errors, not silently removed.

| Surface                               | Compared | Exact matches | Result   |
| ------------------------------------- | -------: | ------------: | -------- |
| Top-level RoomView                    |        3 |             0 | mismatch |
| Closed-corner RoomView                |        4 |             0 | mismatch |
| Stale runtime room/corner-list probes |        4 |             0 | live 404 |

Observed mismatch classes, recorded without message text or raw identifiers:

- Live membership and corner collections changed after the consistent snapshot, causing array membership and ordering drift.
- The local corner RoomView omitted the old reader's sibling-corner list and watch filters.
- Corner repository/repository-resolution inheritance did not match.
- Globalized identity/profile resolution differed from the old reader's community-scoped identity in member and viewer objects.
- Some activity/fact/message projection and latest-turn collections differed.
- Server startup expired stale imported presence, while the live response still carried a historical presence object.

Because stable closed corners also showed structural differences, snapshot drift does not explain the entire result. The cut remains a **no-go** until these projection gaps have explicit parity fixes or the owner approves a documented contract change.

## Timed cut rehearsal

| Stage                                                                                        |                Wall clock |
| -------------------------------------------------------------------------------------------- | ------------------------: |
| Final import                                                                                 |                  87.000 s |
| Server start to `/healthz`                                                                   |                   1.038 s |
| Authenticated local `sendRoomMessage` then `GET /rooms/:id`, with exact message verification |                   0.117 s |
| **Cut path**                                                                                 | **88.155 s (1m 28.155s)** |
| Read-only production dump                                                                    |                 340.629 s |
| **Snapshot extraction through verified flow**                                                | **428.784 s (7m 8.784s)** |

The measured path supports the owner's 10–20 minute operational window with more than two minutes of margin even when snapshot extraction is included. This is timing evidence only; parity is a separate release gate and currently fails.

## Go/no-go checklist

- Import correctness and resume: pass.
- Audit exclusion: pass.
- Full and recommended-media storage: pass.
- Server boot and local end-to-end flow: pass.
- 10–20 minute window: pass.
- Live RoomView exact parity: **fail; cut blocker**.
- Production cut: not performed and not authorized by this rehearsal.
