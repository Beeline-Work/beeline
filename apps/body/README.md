# @beeline/body

The Beeline helper is a thin client that turns explicitly addressed Room messages and eligible
per-sender follow-ups in top-level Rooms and corners into agent replies. Direct messages retain
their existing explicit-mention and direct-reply routing.

It keeps only four responsibilities:

1. connect an app-authorized agent and store its monolith daemon credential;
2. supervise one read-only Room loop per active Room;
3. run the selected ACP harness with isolated home/sandbox state;
4. self-update with a functional session-and-turn probe.

Room data and writes go through `DaemonApiClient`. The helper has no relay transport, legacy
pairing-code redemption, approval or mandate engine, work calendar, repository lifecycle, or
GitHub event consumer. Its action surface is repository corner start/status plus Room-to-corner
steering: `read-only-mcp.ts` exposes `open_corner` and `steer_corner` in top-level Rooms and
`pr_checks_status` in corners through the `beeline-agent` MCP surface. Corners do not post reports
back to their parent Room; their Room-facing output is server-owned cards.

When an imported MCP server is added or removed from the selected harness's operator
configuration, the helper replaces its retained Room or corner session before the next turn.
An unchanged server-name set retains the session; editing settings under an existing name
does not trigger replacement. This applies to all imported servers, including Trusty Squire.
Import classifies each declaration `local` (copied into the isolated harness home as-is) or
`host` (kept out of it — reaching that server is the host's job); Squire is code-owned as host.
Goose uses the same classifier.
It does not provision or revoke routes itself. The inventory contract lives in
[`session-config-fingerprint.ts`](src/session-config-fingerprint.ts); classification lives in
[`mcp-route-class.ts`](src/mcp-route-class.ts).

## Commands

- `beeline connect [code]`
- `beeline connect-finish <grant>`
- `beeline start [--agent <pubkey>]` — update the helper, then start every paired host agent (already-running is a no-op)
- `beeline stop --agent <pubkey>`
- `beeline daemon --config <runtime.json>`
- `beeline update ...`
- `beeline --version`

## Development

```sh
npm run typecheck -w @beeline/body
npm run build -w @beeline/body
npm test -w @beeline/body
```

The end-to-end monolith proof is `src/daemon-api-client.integration.test.ts`. It starts the real
server surface, completes device pairing, exchanges the daemon credential, delivers a human
mention, and verifies the agent reply in the Room read model.
