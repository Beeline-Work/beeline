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
GitHub event consumer. Its action surface is `open_corner(room, brief)`, `order(address, text)`,
`report(text)`, `read(address)` and `watch(address)` through `read-only-mcp.ts`.
A DM can drive work across every Room the agent belongs to. The caller that opens a corner
is its commander; orders reach the current implementer and reports return one step up.
The return route comes from `rooms.created_by` and the existing opening command's parent,
without a responsibility table or work ledger. Private payloads live only in `agent_commands`;
agent-to-agent orders, reports, drafts and final replies have no transcript or phone push.
A report to a human appears where that human gave the order.

Opening automatically watches the corner for opened, merged and closed lifecycle events.
Schedules, chatter and check events never trigger that watch. Merge delivery uses the corner
watch; Room merged subscriptions and repository merged-PR subscriptions are retired.
Every reachable member agent may call `merge_corner`, including from a DM, subject to the
existing green-checks, exact-head yes and no-hold gate. Resource and human-consent rules remain
owned by their existing operations.

A corner is repository work exactly when its parent Room has a repository: it receives a
feature branch, token and worktree. Otherwise it works in scratch and delivers artifacts.
Run `npm run prove:command-grammar` for an isolated review Workspace proof through the built
MCP tools, authenticated HTTP, PostgreSQL notifications, live helper sockets and phone reads.
The proof launches no harness or production helper. Deploy the server before the updated helper.

When an imported MCP server is added or removed from the selected harness's operator
configuration, the helper replaces its retained Room or corner session before the next turn.
An unchanged server-name set retains the session; editing settings under an existing name
does not trigger replacement. This applies to all imported servers, including Trusty Squire.
Import classifies each declaration `local` (copied into the isolated harness home as-is) or
`host` (kept out of it until an owner-only `mcp` grant routes it in); Squire is code-owned as
host. Goose uses the same classifier. An approved route is rewritten onto host state and written
into the isolated home, never copied verbatim, so the server the agent reaches is the operator's
own; revoking removes it. Grant and revoke both change the prepared name set, so the route
appears or disappears on the next session, never mid-turn. The inventory contract lives in
[`session-config-fingerprint.ts`](src/session-config-fingerprint.ts); classification lives in
[`mcp-route-class.ts`](src/mcp-route-class.ts) and route rewriting in
[`host-mcp-route.ts`](src/host-mcp-route.ts).

## Commands

- `beeline connect [code]`
- `beeline connect-finish <grant>`
- `beeline start [--agent <pubkey>]` — update the helper, then start every paired host agent (already-running is a no-op for the agent; the host Trusty Squire broker service — a systemd user unit on Linux, a launchd job on macOS — is installed either way)
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
