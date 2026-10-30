# Optional Room requests: native before/after proof

Reproduction latency-night-2026-10-30: open a Room from its list or a push
with one or five new messages. Before the change, optional requests could start
before the new message's native draw, and foreground push taps repeated the
store-version request. The Room-list one-new request contract failed.

## Measured path

Both captures use the existing six-case native rig: twenty samples per case,
local seeded PostgreSQL/HTTP fixture, 100 ms shaped RTT, no jitter, 10 Mbps,
Hermes release APK, squire se_api35 x86_64 emulator (2560 MiB, four guest cores).
The after capture uses the corner-owned replacement emulator after the earlier
emulator stopped; the device configuration and network profile are unchanged.
This is a local stand-in for production, without real FCM delivery, notification
shade latency, TLS, physical display scanout or a physical handset claim.

Baseline APK source: `b6112caeef3eaecfd4f59657af12c321ad8a3964`.
SHA-256: `c393fd1612bc37f186f30bccb02e661cf5ad8a2abd0b35ee313063d92632d2c2`.
The baseline bundle was frozen before runtime edits; its analyzer commit label
was corrected explicitly to that source rather than the later checkout HEAD.

After APK source: `26dcf24391b9d2f09d2ee988dbe02e1115541a2c`.
SHA-256: `6375f688b988bcbd96a198e00385002e6671344b8996e2619a4dfc6c62fe40a0`.
Subsequent evidence-only commits do not change this measured runtime.

Both reports were generated using the current analyzer. All samples, including
the baseline timeout, remain in the statistics. The timeout is a five-second
censored failure bound, not an observed paint time.

## Results

| Case | Before p95 (ms) | After p95 (ms) | After request contract | After timing budget |
| --- | ---: | ---: | --- | --- |
| Room list, one new | 1310 | 430 | PASS | PASS |
| Room list, five new | 968 | 506 | PASS | FAIL |
| Push, one new | 769 | 444 | PASS | PASS |
| Push, five new | 1439 | 499 | PASS | FAIL |
| Warm Room | 702 | 288 | PASS | PASS |
| Send text | 244 | 188 | FAIL | FAIL |

Rig before/after: room-list-1=1310->430ms; room-list-5=968->506ms; push-1=769->444ms; push-5=1439->499ms; warm-room=702->288ms; send-text=244->188ms

All eighty after arrival samples have zero optional requests before native draw,
with one required Room request and serial depth one. Room-list one-new's request
contract changes from FAIL to PASS. Its baseline maximum was six prepaint HTTP
requests, depth five and four optional requests. All after samples finish without
a timeout; the baseline has one timeout.

Read-mark HTTP requests start within one second of native draw in all eighty
after arrival samples. The maximum conservative upper bound, including clock
uncertainty, is 866 ms. This measures the request reaching the local proxy, not
only a JavaScript callback. Baseline has four missing marks and late requests
up to a 1673.5 ms upper bound. The store endpoint is requested once in the after
run versus forty-four times before.

The overall rig still FAILS: the five-message arrival cases exceed 450 ms, and
send-text exceeds 150 ms and fails its request contract. These failures remain
visible. This corner does not claim to resolve the independent cache/render/send
work or establish a passing nightly baseline.

Host load differs substantially: baseline one-minute load ranges 14.44–62.52;
after ranges 1.16–12.44 on a twenty-CPU host. Therefore the p95 comparison is a
measured before/after result with a load confound, not an isolated causal speedup.
The request ordering, read-mark deadlines and store request counts are directly
checked on every applicable sample. Clock calibration is verified in both runs
(maximum uncertainty 13.5 ms before and 14.5 ms after).

## Validation and retention

Focused mobile regression tests pass (181), including the real open sequence,
failed-read reporting, read-cursor deadlines, draw visibility and hourly store
throttling. Native-resource timing tests separate response arrival/body completion
from delayed JavaScript handling; unsupported store binaries omit the native
network measurement instead of reporting callback delay as network time. The
server telemetry tests cover both stored fields and integer delay validation.
Root typecheck, rig deterministic tests (56), workflow path checks and the
unchanged dead-code baseline pass. The CI proof CLI test exercises an actual git
change and fails without all six numeric measurements, then passes with them;
unrelated paths remain unblocked.

The complete route-inventory check still reports pre-existing missing budgets
for `/beeline/browser-share` and `/beeline/google-callback`, both present at the
baseline source. Adding those budgets remains follow-up work outside this brief;
the fixed nightly six-case matrix is fully captured here.

`before.json`/`after.json` contain aggregate reports. `before-samples.json` and
`after-samples.json` retain all per-sample native durations, clock uncertainty,
optional/prepaint counts and read-mark delays without request bodies, text,
identifiers or fixture secrets. Full raw runs, APKs, host-load samples and all
failed/interrupted diagnostic attempts are retained in this corner's declared
`.beeline-proof/latency-optional` output, excluded from the PR. Failed attempts
were not combined with the final capture or silently discarded.
