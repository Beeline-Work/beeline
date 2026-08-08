# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Gate / live security tests

- Product authority: `spec.md` (esp. **Failure modes → Agent in push-rights**).
- Merge-gate library + worker: `apps/gate/` (see `apps/gate/README.md`).
- Live suite (real Buzz relay): `cd apps/gate && npm run test:live` after `npm run stack:up` at repo root. Soft-skips only when the relay is unreachable.
- Provisioning check (agent never in push-allowed): `apps/gate/src/provisioning.ts` (library + CLI via `npm run provisioning -w @buzzy/gate`).
- One-shot end-to-end proof remains `npm run prove` (`scripts/money-shot.ts`).

## Body (@buzzy/body) — agent session manager

- `apps/body/` — agent body service (see `apps/body/README.md`).
- **Read-only boundary = mount boundary**: TLC sessions get `mcpServers: []` (no write tools); edit sessions get `buzz-dev-mcp` for shell/str_replace. Enforced at ACP `session/new`, not via prompt.
- Body drives `buzz-agent` directly over stdio (NOT `buzz-acp`), because `buzz-acp` auto-approves permissions and doesn't expose `session/update` to the relay.
- Activity projection: body bridges ACP `session/update` → kind:9 `#t=agent-activity` channel events for multi-user visibility.
- Subchannel = child channel (kind:9007, UUID) + mirrored members + git worktree + edit-mode ACP session.
- buzz-agent ACP wire vs MCP: `initialize` uses `protocolVersion` u32 (not MCP string), `clientCapabilities` (not `capabilities`). `session/new` returns `{sessionId}`. Standard MCP for `buzz-dev-mcp`. See `apps/body/src/acp.ts` for exact wire format.
- Live suite: `cd apps/body && npm run test:live` (pretest builds all deps). Soft-skips when relay or LLM env (BUZZY_LLM_*) absent.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
