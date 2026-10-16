# Free-agent harness comparison

Images for implementation `3976d8a70`:

- `registry.fly.io/beeline-free-agents:cmp-opencode-3976d8a70`
- `registry.fly.io/beeline-free-agents:cmp-pi-3976d8a70`

Push those test tags from an authenticated Docker environment. Never retag or
push `latest` for this proof. Both images have already built locally; their
uncompressed sizes are 258,517,483 bytes (OpenCode) and 157,624,723 bytes (Pi).

Read both scripts before running them. The runner uses only Node built-ins.
With a Fly token already available in the backend environment:

```sh
node infra/free-agent/compare-machines.mjs 3976d8a70
```

This creates five fresh Machines per harness in `beeline-free-agents`, alternating
order, with one shared CPU and 2048 MB RAM in `iad`. Creation uses `skip_launch`,
then the driver times the start request until the harness answers ACP
`initialize`. This includes API latency and guest startup, excludes image
provisioning, and reports the harness-process interval separately. It writes
`/tmp/beeline-harness-comparison-results.json`, reports a median only with all
five samples, and destroys each Machine in `finally`. Failed deletions are
listed in the result and cause a nonzero exit; delete those IDs before finishing.

For the model task, stage `BEELINE_FREE_AGENT_MODEL_TOKEN` as a Fly app secret,
verify only its non-empty presence on one disposable Machine, and provide
`MODEL_BASE_URL` in the driver environment. The driver never passes the token
in Machine config env. Then run:

```sh
node infra/free-agent/compare-machines.mjs 3976d8a70 --task
```

The base URL must accept `/chat/completions` for
`deepseek/deepseek-v4.1-flash`. A Beeline free-agent proxy also requires a live
claimed command; a standalone harness cannot use an idle free-agent token.
The scripted task reads `orders.json`, calculates item totals, writes
`answer.json`, and returns a prescribed total. The runner checks the actual file
and reply, records request model/output caps, and captures final provider usage
per request, including auxiliary harness calls. Missing usage fails the run.
The local forwarding shim requests streaming usage without changing other
request fields. Each harness uses its own native tools and normal defaults.

Local Docker smoke checks passed for ACP initialization and the complete task
with a deterministic model stub. Stub token counts and local process-start
intervals are plumbing checks, not DeepSeek results or Fly boot medians.
The model comparison and the Workspace/#general user-path proof remain required
before a merge recommendation. This standalone runner does not prove Room
transport, command-claim authority, or model allowance enforcement.

## Fly cold-boot results, 2026-10-16

Raw samples: `comparison-3976d8a70-boot.json`.

| Metric | OpenCode 1.18.31 | Pi 0.84.3 / pi-acp 0.0.34 |
| --- | ---: | ---: |
| Median start request to ACP initialize | 11,393 ms | 3,679 ms |
| Median harness spawn to ACP initialize | 8,420 ms | 684 ms |
| Successful cold boots | 5/5 | 5/5 |
| Built image size | 258,517,483 bytes | 157,624,723 bytes |

The cold-boot median is 67.7% lower for Pi. The run alternated order as specified
above, used fresh Machines, and made no model requests. Authentication used the
vaulted Machines API route via a local fetch bridge; end-to-end timings include
bridge, vault and API latency. Image provisioning is excluded. HTTP 412 during
rootfs preparation is retried before the accepted start request's timestamp.
Two start/cleanup timeouts were resolved by authoritative Machine state reads;
one create needed a retry and was adopted by its unique sample name. These
recoveries and the excluded incomplete preflight are recorded with the samples.
All ten measured Machines and both preflight Machines were destroyed. The final
Machines API list returned zero Machines. The model task results are recorded below. The Workspace/#general path remains
a separate integration proof.


## V4.1 Flash task results, 2026-10-16

The corrected collection ran five fresh Machines per harness, in alternating
order, with the same task, model and resource settings. Every upstream request
returned usage before the result was finalized. Raw samples and per-request
prompt/completion totals: `comparison-3976d8a70-task.json`.

| Metric | OpenCode | Pi |
| --- | ---: | ---: |
| Image size | 258,517,483 bytes | 157,624,723 bytes |
| Earlier cold-boot median | 11,393 ms | 3,679 ms |
| Task success | 5/5 | 5/5 |
| Correct output file | 5/5 | 5/5 |
| Median prompt tokens/turn | 23,283 | 5,118 |
| Median completion tokens/turn | 491 | 162 |
| Median total tokens/turn | 24,110 | 5,280 |
| Median turn wall time | 3,793 ms | 2,283 ms |

Each median is calculated independently across all five runs. Token counts
include cached input and auxiliary harness calls; these are provider-reported
tokens, not the Beeline allowance's weighted charged tokens. OpenCode makes
auxiliary title calls; the collector waits for those to return usage as well.
Turn wall time ends when ACP returns the prompt result; waiting for auxiliary
usage is recorded separately. Pi used 78.1% fewer median total tokens and had a
39.8% lower median turn wall time in this batch, with equal task success.

An initial batch used the earlier collector. It finished before an asynchronous
OpenCode title request's usage arrived in one sample. The collector was fixed
to drain every active model request, then the entire alternating batch was
repeated. The initial batch is preserved in
`comparison-3976d8a70-task-preflight.json`; both harnesses passed 4/5 strict reply
checks and wrote the correct file in 5/5. Across both batches each harness
therefore passed 9/10 strict tasks and 10/10 file checks. The earlier failures
are retained, and the rerun does not establish perfect response formatting.

The one secret-presence check returned only `present: true`. The check Machine,
the ten initial task Machines, and the ten corrected task Machines were all
deleted. The final Machines API list was empty. The key was inherited from the
Fly app secret and never fetched, printed, or sent in Machine config env. The
commander owns unsetting that temporary secret. All model requests stayed at
or below 65,536 output tokens. This comparison does not exercise a long session
or Workspace/#general transport; those integration limits remain explicit.
