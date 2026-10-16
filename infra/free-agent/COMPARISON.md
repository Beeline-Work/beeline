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

For the model task, provide `MODEL_BASE_URL` and
`BEELINE_FREE_AGENT_MODEL_TOKEN` through backend environment injection, then run:

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
