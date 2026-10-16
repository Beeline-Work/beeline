# Free-agent abuse guards

Reproduction `FREE-ABUSE-1` (2026-10-16): a valid copied model token, with
no command or turn in the database, reached the upstream HTTP model and charged
240 tokens for 500 prompt tokens (300 cached) plus 40 completion tokens. The
baseline `pins the model` HTTP test demonstrated that behavior on 112173728.
Free agents are not released, so an isolated server is the real-target stand-in.

The same HTTP path now returns 403 with zero upstream calls and zero charge when
idle, and 200 while an input command has a live lease. The cached example now
charges 315 tokens. Expired leases, turns past the wall clock limit, and turns
reclaimed with a newer claim but an old start time are refused. The per-owner
minute counter and global dollar reservations serialize admissions in PostgreSQL.

Defaults: 25% cached tokens, 30 calls per owner per UTC minute, $25 shared per UTC
day, 900 seconds per turn, and 60 seconds of server cancellation grace. Fallback
reservation prices are $1/M input and $5/M output; operators must keep them above
their pinned model's worst-case prices. OpenRouter reported costs settle the
reservation, and `model_usage` events retain each call's charged tokens and USD.

## Local end-to-end proof

Ran `scripts/prove-free-agent.mjs` with `SAMPLES=1`, against an isolated PostgreSQL
17 container, current server/helper builds and the Docker Machines stand-in.
There was no production deploy or release. The stand-in mounted the checkout
read-only and supplied executable helper/MCP launchers; it used the existing
`beeline-free-agent:local` image and a private container home.

The proof script exited 0. The rewake observation did not contain a new helper
registration event; its registration latency is unknown.

A local in-memory upstream bridge used Squire `use_credential` to call the real
`deepseek/deepseek-v4-flash` model without placing a provider key in the local
server. The bridge converted full JSON responses to SSE. To fit the connector's
64 KiB body ceiling it removed tool descriptions when needed, and on later turns
dropped old harness message history before the newest user prompt. Tool names,
parameter schemas and the current request were retained. This is a transport
stand-in, not a production latency measurement or proof of unmodified prompt
history at the provider.

Observed output:

```text
2026-10-16T11:54:13.915Z free agent @echo (db99cae4af02)
2026-10-16T11:56:29.413Z hello after 135.4 s
2026-10-16T11:57:17.452Z task reply after 47.9 s:
  proof.txt created; sha256 3cd3c9549da30d8fe5b24ee0da67d166bf39d5627c77d19f5a0860059d56b2d4
  uname: Linux squire 6.8.0-142-generic ... x86_64 GNU/Linux
2026-10-16T11:57:54.882Z join greeting; exact=true
2026-10-16T11:58:54.138Z exit note returned
2026-10-16T11:59:53.893Z sample 1: asleep
2026-10-16T12:00:13.020Z sample 1: wakeRequestedMs=28; machineStartedMs=82;
  helperRegisteredMs=null; replyVisibleMs=13971; reply="pong"
```

For the outside-turn check, a bootstrap observer held this agent's actual model
token only in memory. After the database showed zero pending/claimed commands,
it supplied the token to `curl --config -` over stdin, avoiding token files,
command-line arguments and output. The model request returned:

```json
{"curlExit":0,"modelStatus":403}
```

The unit HTTP reproduction separately verifies zero upstream fetches and zero
charge for that refusal. A real ACP subprocess test sustains tool activity for
14 simulated minutes, then proves cancellation exactly at minute 15 and the
continuation note. The Room publishing test proves the note is saved and the
receipt completes; the reaper test proves an overdue command stops its Machine
even when the Machine is still reporting recent activity.

## Regression validation and remaining browser blocker

- Root `npm run typecheck`: passed, including mobile and scripts.
- Server `free-agent-model-proxy.test.ts`, `free-agents.test.ts`, `database.test.ts`:
  80 passed.
- Helper `acp-liveness.test.ts`, `free-agent-vm.test.ts`, `server-command-intake.test.ts`,
  `monolith-room-turn.failure.test.ts`, `monolith-corner-turn.test.ts`, `config.test.ts`:
  192 passed.
- `npm run lint:workflow-paths`: passed (49 references).

The required browser regression is **not complete**. Squire opened
`web.usebeeline.app` and loaded `#experiments` in the existing owner session.
Connectors confirmed `beeline-reviewer-bypass` / `play-review-login-link` is
connected. Loading its single `value` field through `operate_login(load_saved)`
failed with `unsupported_credential_type`; navigation has no sealed-slot input.
No raw login URL was fetched and no message was sent from the owner session.

Next step: provide a supported sealed reviewer-login navigation route, then open
a Room and verify an agent's answer in that reviewer session. Free agents are
not yet released: this production browser check is a regression check only.
