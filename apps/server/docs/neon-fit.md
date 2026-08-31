# Phase B Neon-fit verification

Measured 2026-08-31 against an isolated host-local PostgreSQL database. No production container, database, credential, Fly application, or Neon project was accessed.

## Rehearsal shape

- the complete `apps/server` schema and every declared index;
- 35,035 message rows, matching Phase A's count of live legacy events;
- 928 bytes of uncompressible-looking MD5-derived text per message, deliberately larger than the measured average live event payload;
- 91,045,022 bytes of cryptographically random media split across four rows below the old 25 MB cap.

`measureDatabase` sums `pg_total_relation_size` for every public table. That includes heap, TOAST, and indexes.

| Item                                                                        |                   Bytes |
| --------------------------------------------------------------------------- | ----------------------: |
| Full schema + indexes + rehearsal messages + exact measured media bytes     |             147,447,808 |
| Conservative carry-forward for Phase A non-audit, non-event relational rows |              25,840,039 |
| **Conservative verified total**                                             |         **173,287,847** |
| Neon Free ceiling                                                           |             500,000,000 |
| **Remaining headroom**                                                      | **326,712,153 (65.3%)** |

The carry-forward is Phase A live logical rows minus the excluded audit log and live events: `381,389,746 - 319,683,112 - 35,866,595`. This intentionally assumes those remaining rows take the same bytes after normalization even though many legacy event-shaped operational facts become smaller typed rows.

## Verdict

The owner-required audit exclusion changes the Phase A result. The verified Phase B layout is safely below the 500 MB ceiling, so implementation does not need a storage-cost decision. The measurement command still exits nonzero at the ceiling, and the final Phase C snapshot import must run it again before writes reopen.

## Exact post-rehearsal breakdown

This table is the exact `pg_total_relation_size` result after the Phase B capacity rehearsal, including each table's heap, TOAST, and indexes. It is deliberately distinguished from a real-user import: Phase A supplied aggregate production byte counts, not an offline snapshot, and Phase B is forbidden from querying the live production containers. The importer and `npm run measure -w @beeline/server` now emit this same breakdown automatically for the eventual offline snapshot.

| Top table               |      Bytes |
| ----------------------- | ---------: |
| media                   | 94,568,448 |
| messages                | 52,101,120 |
| memberships             |     81,920 |
| rooms                   |     65,536 |
| identities              |     49,152 |
| workspaces              |     32,768 |
| daemon_tokens           |     24,576 |
| github_auth_flows       |     24,576 |
| github_repositories     |     24,576 |
| identity_external_links |     24,576 |

The event fixture contains 35,035 human-message rows (40,080,040 logical row bytes). Agent messages, receipts, activity, facts, presence-adjacent rows, and retired kinds are each zero because the rehearsal intentionally padded one conservative message shape; it did not invent a production event mix. The four media objects total 91,045,022 payload bytes and all four are unreferenced by a kept message in this rehearsal. None match the `canary|test|fixture|sample|probe` filename/legacy-URL heuristic. This explains the owner's concern: **146,669,568 of the 147,447,808 physical bytes (99.5%) are the deliberately conservative message/media load, not baseline state for one light user.** It is a ceiling rehearsal, not a usage estimate.

No import policy changed. On a real snapshot, the emitted JSON splits media into `referenced-by-kept-message`, `orphan-unreferenced`, and `orphan-likely-canary-or-test`, and splits kept event storage into human messages, agent messages, receipts, activity, facts, presence-adjacent, retired, and other rows. Those exact snapshot results are the input to any later retention decision.
