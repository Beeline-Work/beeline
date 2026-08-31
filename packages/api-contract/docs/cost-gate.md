# Phase A measured cost gate

Measured 2026-08-31 against the owner-specified production containers. All database commands were `SELECT`/statistics reads; container and filesystem commands were read-only.

## Measurements

| Item                         |  Measured bytes |        MiB | Method                                                                                                                                                                               |
| ---------------------------- | --------------: | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL live logical rows |     381,389,746 |     363.72 | Sum of `pg_column_size(row)` for non-backup public tables; `events.deleted_at`, `channels.deleted_at`, removed/hidden memberships, removed reactions, and deactivated users excluded |
| Of that: live events         |      35,866,595 |      34.21 | 35,035 live rows; 877,179 tombstoned event rows excluded                                                                                                                             |
| Of that: audit log           |     319,683,112 |     304.87 | 1,104,009 live rows                                                                                                                                                                  |
| MinIO live store             |      91,045,022 |      86.83 | Apparent bytes under `/data` in `buzz-router-prod-minio-1`                                                                                                                           |
| Push registry JSON           |          17,180 |       0.02 | `/var/lib/buzzy-push/registrations.json`; 4 registrations and 49 OTA receipts                                                                                                        |
| Minimum expected indexes     |     157,138,944 |     149.86 | Existing audit-log indexes alone; this is a measured lower bound and excludes every message, membership, read-mark, auth, GitHub, and media index the new schema also needs          |
| **Conservative Neon total**  | **629,590,892** | **600.42** | Live rows + MinIO + registry + index lower bound                                                                                                                                     |

The 0.5 GB Neon Free storage ceiling is 500,000,000 bytes. Rows + media + registry are already 472,451,948 bytes (94.5% of the ceiling) before indexes. The conservative indexed total exceeds the ceiling by 129,590,892 bytes (25.9%).

## Connection and compute observation

- PostgreSQL reported 25 connections during measurement: 24 application connections plus the measuring `psql` session.
- The relay held 23 idle application connections at that instant. The TypeScript materializer pool is configured for 5 and auth for 10, so the present architecture's configured/observed footprint is unsuitable as a direct Neon Free transplant.
- Phase B must give each of the two Fly processes one small shared pool. A proposed maximum of 5 per process (10 total) is the cost-gate ceiling, not a Phase A runtime change.
- Storage fails before a defensible 100 CU-hour estimate can be made. Phase B must still measure the rehearsed two-Machine compute workload; Phase A does not claim that the compute allowance fits.

## Verdict

**DOES NOT FIT Neon Free as scoped.** The measured production live set plus a proven index lower bound exceeds 0.5 GB. This is the owner storage-cost question from the corrected plan: choose paid storage or explicitly reduce retained data/media. Phase A does not choose or discard anything.
