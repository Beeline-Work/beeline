# Server pool JIT proof

Reproduction R-JIT-POOL, October 22, 2026, PostgreSQL 16.15 on squire.
The actual PhoneService methods ran over real pooled connections. These are
service completion times, including DTO shaping, not phone paint times or
production latency. A production phone cannot exercise this unshipped pool
configuration; the local service path is the stand-in recorded in brief revision 2.

| Read path | JIT on p50 / p95 (ms) | Pool JIT off p50 / p95 (ms) |
| --- | --- | --- |
| Corner list, readCorners | 733.39 / 827.80 | 45.58 / 57.65 |
| Room list, readChats | 387.09 / 424.00 | 66.22 / 73.16 |
| Transcript page, readHistory | 12.15 / 15.11 | 12.02 / 14.30 |

Each path has 30 measured samples per mode after three warmups per mode.
Modes alternate order on each iteration, on the same data and shared host.
The baseline overrides only the startup option to `-c jit=on`; the after
connection uses `postgresPoolConfig` unchanged. The default JIT cost threshold
remains 100000. Response sizes match per path: 46228, 113638 and 24161 bytes.
Raw percentile output is in `jit-pool-b4abc.json`.

The seed-local fixture has 200 Rooms in the busy Workspace, 300 child corners,
518 memberships across all fixtures and 13031 messages. Autovacuum was disabled
on this disposable database's tables before seeding. After seeding, ANALYZE
recorded 10031 messages; another 3000 old activity messages were then inserted
without ANALYZE. The statistics still report 10031 message tuples. This tests
stale statistics without changing the threshold or production configuration.

EXPLAIN ANALYZE of the captured corner-list SQL on that fixture estimated cost
155779.77, compiled 977 functions and spent 597.027 ms in JIT (524.023 ms emission).
Execution was 634.410 ms with JIT on and 16.057 ms with JIT off. These plan
execution times exclude the other service queries and DTO work in the table.
A separate early fixture with empty/uninitialized statistics chose a cheap
estimated plan that never invoked JIT and did not improve with the setting;
that exploratory fixture is not the benchmark above. Turning JIT off removes
compilation overhead, not every possible poor plan.

## Repeat

Use only a new disposable loopback database whose name contains `latency_rig`.
Build the workspaces with `npm run corner:prepare`. Migrate that database with
`migrate(new PostgresDatabase(url, 1, { mode: 'migration' }))`, then close it.
On this disposable database only, disable autovacuum for public tables before
seeding (the following psql commands use the local database name from this run):

```sql
SELECT format('ALTER TABLE %I.%I SET (autovacuum_enabled=false)', schemaname, tablename)
FROM pg_tables WHERE schemaname='public' \gexec
```

Seed using `LATENCY_RIG_DATABASE_URL=<local-url> node scripts/latency-rig/seed-local.mjs`.
Run `ANALYZE` once, then execute this growth insert without analyzing afterward:

```sql
INSERT INTO messages(id,room_id,author_id,text,presentation,activity,created_at)
SELECT md5('jit-stale-growth-' || n), 'f13fbac4-e500-4f81-8c20-78bc02c3aac8',
'a20051619213d49342620f14e5dfbf5bd73c4c794c835e6cab4f8e1e050645b9',
'Fixture stale-statistics activity ' || n,'activity','[]'::jsonb,
now()-interval '60 days'+n*interval '1 second' FROM generate_series(1,3000) n;
```

Run `LATENCY_RIG_DATABASE_URL=<local-url> node --import tsx scripts/latency-rig/measure-jit.mts output.json`.
Do not run this setup against production. No global database or role settings
were changed. Drop the disposable database after use.

## Regression and validation

`database-jit.test.ts` verifies SHOW jit = off on two simultaneous new
connections and a reused pooled connection, for every pool mode. CI runs the
real PostgreSQL proof in the existing isolated PostgreSQL job, with no new job
or renamed required context. The ordinary suite also checks startup options.

The database and JIT suites passed (58 tests). The final JIT test cleanup change
was rerun (10 passed). Root typecheck and workflow-path checks passed. Existing
pool statement/lock deadlines stay intact. No query rewrite is included.
