# Pi startup checks: Fly proof

2026-10-16. Reproduction `pi-startup-checks`. Performance optimization, not a defect report.

`pi-acp` 0.0.34 runs two synchronous `pi --version` probes and an npm registry
lookup before answering `session/new`. Beeline now patches those informational
checks when Node loads the adapter, without modifying its installed files.
The selected executable's package/bin metadata supplies the version, including
`PI_ACP_PI_COMMAND`. A custom executable without matching metadata gets one
bounded asynchronous probe after session creation. Its result is a
`session_info_update` metadata field, never model text. Probe failures are ignored.
The helper no longer sends Pi's registry update notice.

The preload restores the original `NODE_OPTIONS` before Pi or MCP children
start. It does not change extension imports, module contents outside the adapter's
notice code, Room state, process isolation, or when sessions start. The adapter
source replacements were originally checked with a fatal unsupported-source
error. The later startup fallback fix returns the original source unchanged
when anchors or required bindings change, restoring synchronous checks instead
of preventing startup.

## Reproduced

Use the existing free-agent image digest
`fc5e3236992b1ff2a362801042f1ed8a56bf50cd7c68d001748ffe38d97654bb` on a disposable
Fly Machine, iad, 1 shared vCPU, 2048 MiB. Override init with `sleep infinity`;
do not configure a helper, identity, Workspace, bootstrap, or grant. Versions:
Node 22.23.3, Pi 0.84.3, adapter 0.0.34.

For `pi-startup-checks`, create a separate HOME, Pi settings and session store,
and Room cwd for each sample. Install the investigation's generated MCP bridge,
using the real read-only MCP entry bundled from source. Configure a local unused
provider endpoint so session creation cannot spend provider credit. Start the
adapter, initialize ACP, then measure its `session/new` response with a monotonic
clock. Baseline runs use the installed adapter unchanged. Alternate baseline and
cut three times on the same Machine; cut runs use `piStartupEnvironment` from the
built helper. Each successful response retains the expected `pi v0.84.3` banner
and bridge discovery record.

## Demonstrated

Same reproduction, final implementation, Machine `2862135fd37978`:

| Pair | Baseline session/new, s | Patched, s | Saving, s |
| --- | ---: | ---: | ---: |
| 1 | 2.658 | 0.891 | 1.766 |
| 2 | 2.056 | 0.892 | 1.164 |
| 3 | 2.109 | 0.936 | 1.172 |
| Median | 2.109 | 0.892 | 1.172 |
| Range | 2.056–2.658 | 0.891–0.936 | 1.164–1.766 |

Including ACP initialization and loader overhead, baseline total startup has
median 2.344 s (2.305–3.025), versus 1.242 s (1.219–1.290). Paired total saving
has median 1.063 s (1.054–1.805). The source baseline is
`1aed7b4235d4a61bca85975c1d08cab13edfaa02`; the patch is this PR.
Fly CPU and registry variation differ from the investigation's 0.818 s result;
this is a new paired measurement, not a fixed latency promise.

For wake, retain separate baseline and patched ACP sessions on the disposable
Machine. A localhost OpenAI-compatible SSE stand-in returns `WAKE_OK`; the real
Pi adapter handles `session/prompt` and emits that visible reply. Suspend and
resume the Machine four times, measuring both sessions after each wake and
alternating which runs first. No new session is started by resume.

| Wake | First | Baseline prompt, ms | Patched prompt, ms |
| --- | --- | ---: | ---: |
| 1 | Baseline | 191.7 | 385.0 |
| 2 | Patched | 201.6 | 189.8 |
| 3 | Baseline | 214.4 | 147.4 |
| 4 | Patched | 149.0 | 197.2 |
| Median | | 196.6 | 193.5 |

Every reply was `WAKE_OK`, `end_turn`. There is no median wake-path regression in
these samples. The patched outlier remains in the results; this small sample
does not establish tail latency. Fly start/control API times vary by seconds,
so these comparisons share the same wake and measure the application path.
This does not measure a real provider or the full production helper wake.

## Regression checks and cleanup

Root `npm run typecheck`, workflow-path lint, and 192 tests across Pi startup,
ACP, isolated agent homes, Room sessions, bwrap, and helper startup passed. The
custom-executable test holds the version child until after `session/new` returns;
awaiting that child would fail. Tests also cover selected package versions,
background failure, relative command resolution in the session cwd, skipping
non-executable PATH entries, and restoring original child `NODE_OPTIONS`.

Both test Machines (`80ee655c130258`, earlier implementation;
`2862135fd37978`, final implementation) were deleted through Fly, HTTP 200,
`{"ok":true}`. No test Workspaces, model grants or other grants were created.
Final Fly inventory contains only:

| Machine | Region | State |
| --- | --- | --- |
| 857614db620078 | iad | suspended |

Production Beebee was read only and never started or changed. Raw final samples
and sanitized cleanup inventory are in
[`pi-startup-cut-proof.json`](../infra/free-agent/pi-startup-cut-proof.json).
