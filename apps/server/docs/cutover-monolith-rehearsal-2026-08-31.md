# Monolith cutover rehearsal — 2026-08-31

The full `scripts/cutover-monolith.sh --rehearse` sequence completed against a local HTTP target and a newly migrated scratch PostgreSQL database. The target origin and database were explicit; the scratch database was removed after the run.

Observed gates, in order:

1. `/healthz` returned `{ "ok": true }`, PostgreSQL accepted a query, all five required schema tables existed, and the phone-auth boundary verification hook completed.
2. Drain and freeze action/verification hooks completed.
3. The target received import `cutover-local-rehearsal` with `state=complete` and `mediaBytes=0`. The server importer suite passed all 4 tests, including zero-media import and interrupted-import resume.
4. The script atomically staged the runtime's one-use `bde_` credential. The local restart harness replaced it with `bdt_`; verification rejected any retained exchange credential.
5. OTA action and receipt-verification hooks completed.
6. The local monolith integration test exchanged a real one-use daemon credential and round-tripped inbox, receipt, authority, settings, presence, Room message, and corner facts. It passed 1/1.
7. Reopen verification completed and the script printed the forward-only warning.

Terminal transcript:

```text
Test Files  1 passed (1) — importer
Tests       4 passed (4)
Test Files  1 passed (1) — daemon local-monolith integration
Tests       1 passed (1)
[cutover] WRITES ARE OPEN. ROLLBACK IS NOW FORWARD-ONLY. NEVER WRITE TO THE OLD SNAPSHOT.
[cutover] rehearse completed; state recorded at <scratch>/state/monolith-fc8340a21447ee33.state
```

The site-specific lifecycle and OTA hooks were harmless local assertions in this rehearsal. Production operators must supply the real commands and verification probes described in `cutover-monolith.md`; the script refuses a missing or failing probe.
