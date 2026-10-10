# Local warm Room RTT sweep

The original route and interaction coverage ledger is in `baseline-coverage.md`.
This follow-up used the same signed local fixture and release Hermes APK, with
the Room already held in device storage. The underlying app commit was
`9a1e028b09f9ae5e97e6767fe1abfcfbe6dbb94a`; the sweep scripts were
uncommitted during capture. Each profile requested 30 serial opens of the same
Room on `emulator-5580` at a 200% host CPU quota. The proxy applied 10 Mbps,
±12 ms jitter and 1% whole-request failure. It did not simulate packet loss.

| Configured RTT | Frames | p50 | p95 | Prepaint HTTP max | Budget |
|---:|---:|---:|---:|---:|---|
| 50 ms | 30/30 | 133 ms | 231 ms | 0 | <450 ms: pass |
| 100 ms | 30/30 | 151 ms | 366 ms | 0 | <450 ms: pass |
| 200 ms | 30/30 | 144 ms | 225 ms | 0 | <450 ms: pass |
| 300 ms | 30/30 | 143 ms | 238 ms | 0 | <450 ms: pass |

These are first meaningful Room frames from the existing in-app marker. The
network profile has little bearing on this already-held screen because no
HTTP request finished before paint. The nonmonotonic p95 values show emulator
variance. These profiles are scenarios, not a derived production RTT. The
local HTTP transport excludes TLS, and 200% quota is not an A15 calibration.

A second 30-open run at the 100 ms profile rebuilt the opt-in APK with
content-ready route marks. It measured `/beeline/channels` warm at p50 19 ms,
p95 23 ms and zero prepaint HTTP. It measured the Room from navigation commit
at p50 227 ms and p95 668 ms, **over** the 450 ms budget. The older Room marker
for the same run measured p50 149 ms and p95 384 ms, illustrating that its
start point was later than navigation commit. The joined trace counted up to
two deck `workspaces`/`chats` GETs that overlapped the Room open, not Room GETs;
the proxy lacks a screen cause ID, so that physical request count cannot be
called a Room dependency count. Report both views rather than hiding the
overlap. The rebuild and warm-up state also changed between runs, so this
30-open failure is evidence of an unstable budget, not a controlled before/
after regression.

The other routes and every tap remain unmeasured; this is not a launch verdict.

Reproduce with `sweep-room.sh` after local sign-in and use
`sweep-summary.mjs` on its four `samples.ndjson` files. The raw captures are
local artifacts under `.local/rtt-sweep/` and contain proxy/SQL trace data;
they are deliberately git-ignored.
