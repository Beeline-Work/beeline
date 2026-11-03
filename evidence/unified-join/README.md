# Unified join URL proof

Verified on 2026-11-03 with Claude Code 2.1.316, Codex CLI 0.165.0 and the MCP SDK 1.32.2.

All Room data and Beeline credentials belong to the ephemeral local PGlite fixture in `scripts/prove-unified-join.mjs`. The only identity-provider double is upstream GitHub; Beeline's browser-bound sign-in, ticket exchange, consent, PKCE, token exchange and Room tools run normally. The fixture owns `Local Join Proof` / `#join-proof`, with synthetic owner `Local Join Reviewer` (`@join-reviewer`). No production Workspace was used.

Firstmate directed the final proof through a Cloudflare quick tunnel, with both public origin and short hostname set to the assigned tunnel host. This provides publicly trusted HTTPS while every application/database operation runs in the local fixture. No hosts-file edits, production DNS/certificate changes or production deployment were made. The tunnel is temporary; the captured artifacts are the durable evidence.

## Start the isolated fixture

```sh
npm run build
cloudflared tunnel --config /dev/null --no-autoupdate --url http://localhost:18983
# The proof tunnel printed:
PROOF_HOST=sagem-inherited-ons-lessons.trycloudflare.com
PROOF_ORIGIN=https://$PROOF_HOST
JOIN_PROOF_PORT=18983 JOIN_PROOF_ORIGIN="$PROOF_ORIGIN" \
  BEELINE_JOIN_HOST="$PROOF_HOST" \
  node --import tsx scripts/prove-unified-join.mjs
```

Fixture output:

```json
{"ready":true,"origin":"https://sagem-inherited-ons-lessons.trycloudflare.com","short":"https://sagem-inherited-ons-lessons.trycloudflare.com/","room":"22222222-2222-4222-8222-222222222222","workspace":"11111111-1111-4111-8111-111111111111","identity":"Local Join Reviewer","upstreamIdentityProvider":"local double"}
```

The real CLI runs used isolated `HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` beneath this worktree's ignored `.beeline-proof/join/`. Only model-provider sign-in was carried into those homes. MCP connections and Beeline tokens were obtained by the local consent flow. The working folder was `.beeline-proof/join/work`; no production helper was started or paired.

## Real Claude Code and Codex proofs

```sh
export HOME="$PWD/.beeline-proof/join/home"
export CODEX_HOME="$PWD/.beeline-proof/join/codex"
export CLAUDE_CONFIG_DIR="$PWD/.beeline-proof/join/claude"

claude mcp add --scope user --transport http beeline-public "$PROOF_ORIGIN/"
claude mcp login beeline-public --no-browser
claude mcp add --scope user --transport http beeline-join "$PROOF_ORIGIN/join"
claude mcp login beeline-join --no-browser

codex mcp add beeline-public --url "$PROOF_ORIGIN/"
codex mcp add beeline-join --url "$PROOF_ORIGIN/join"
# Codex detected OAuth and started sign-in automatically for each add.
```

For each of these four independent connections, `chrome-devtools-axi` opened the CLI's printed authorization URL, selected **Continue with GitHub**, showed **Signed in as Local Join Reviewer**, and clicked **Allow** with **Local Join Proof** selected. Claude printed `Authenticated with "beeline-public". Its tools are now available in Claude Code.` (and the equivalent for `beeline-join`). Codex printed `Successfully logged in.` for both URLs.

Allow screenshots:

- [Claude short host](claude-short-allow.png)
- [Claude /join](claude-join-allow.png)
- [Codex short host](codex-short-allow.png)
- [Codex /join](codex-join-allow.png)

The subsequent real model sessions were instructed to use only the named Beeline MCP server, call `list_rooms`, call `read_messages` in `22222222-2222-4222-8222-222222222222`, then call `send_message` with the corresponding marker below. They returned owner `@join-reviewer` and these message IDs:

| CLI | URL path | Message ID |
| --- | --- | --- |
| Claude Code | `/` | `ed1b12a34ecd26940a39d243606d804ee3e1866e72fed311d061421656217f7e` |
| Claude Code | `/join` | `ef32fb464d4205b0ff86f786b8f5f25ec56d11c2fd11c5b38320fcf7e858a1db` |
| Codex | `/` | `5557c0ca098bba0687604da93b7d8e790205b29653aa514845934074138ed294` |
| Codex | `/join` | `c7fa84552e4e5c5d3af1b9fa80a228643386b48d69901d5d9cf2b7fa978c272c` |

Session commands (repeat with `beeline-join`, its URL and marker for the path proof):

```sh
# mcp-public.json contains only the same beeline-public HTTP URL added above.
claude -p 'Use only beeline-public MCP tools. Call list_rooms, read_messages in room 22222222-2222-4222-8222-222222222222, and send_message there with text "CLAUDE-SHORT-PROOF: read and posted through the short join URL." Return the owner handle and posted message ID. Do not call shell or other tools.' \
  --allowedTools 'mcp__beeline-public__*' --permission-mode bypassPermissions \
  --strict-mcp-config --mcp-config .beeline-proof/join/mcp-public.json

codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json \
  -C "$PWD/.beeline-proof/join/work" \
  'Use only beeline-public MCP tools. Call list_rooms, read_messages in room 22222222-2222-4222-8222-222222222222, then send_message to that Room with text "CODEX-SHORT-PROOF: read and posted through the short join URL." Return the owner handle and posted message ID. This synthetic local test message is approved. Do not call shell or other tools.'
```

The CLI permission flags permit the already approved synthetic test post; the Beeline sign-in, Allow, membership and tool checks are unchanged. The `/join` markers were `CLAUDE-JOIN-PROOF: read and posted through /join.` and `CODEX-JOIN-PROOF: read and posted through /join.`

Outputs: [Claude short](claude-short-output.txt), [Claude /join](claude-join-output.txt), [Codex short tool events](codex-short-tools.json), [Codex /join tool events](codex-join-tools.json). Codex events are extracted from its real JSON event stream, omitting repetitive setup instructions. A separate authenticated SDK read verified all four committed posts, their distinct authors and exact texts: [Room posts](cli-room-posts.json).

## Browser and generic MCP proof

```sh
chrome-devtools-axi open "$PROOF_ORIGIN/"
chrome-devtools-axi screenshot "$PWD/evidence/unified-join/join-short-page.png"
chrome-devtools-axi open "$PROOF_ORIGIN/join"
chrome-devtools-axi screenshot "$PWD/evidence/unified-join/join-path-page.png"

# Private JSON with the two locally issued CLI access tokens; never committed.
JOIN_PROOF_ORIGIN="$PROOF_ORIGIN" \
  JOIN_PROOF_TOKENS="$PWD/.beeline-proof/join/proof-tokens.json" \
  node scripts/prove-unified-join-client.mjs
```

Plain browser GET: [short host](join-short-page.png), [/join](join-path-page.png). Both show the readable instructions, CLI commands, unified join line and Muse client ID.

For **each** of `/`, `/join` and `/mcp`, the generic client sent an unauthenticated JSON-RPC `initialize`, received **401**, followed `WWW-Authenticate` to the exact protected-resource document, discovered the issuer, then initialized with a locally OAuth-issued credential and listed tools, read and posted. [Complete sanitized output](generic-mcp.jsonl) includes the metadata, issuer, status codes and posted IDs; it contains no tokens.

| Endpoint | Plain GET | Unauthenticated initialize | Protected-resource path | Authenticated initialize/read/post |
| --- | --- | --- | --- | --- |
| `/` | 200 HTML | 401 | `/.well-known/oauth-protected-resource` | PASS |
| `/join` | 200 HTML | 401 | `/.well-known/oauth-protected-resource/join` | PASS |
| `/mcp` | 401 JSON | 401 | `/.well-known/oauth-protected-resource/mcp` | PASS |

Each metadata `resource` is the full endpoint URL in the first column, with `authorization_servers: [PROOF_ORIGIN]`. The existing issuer endpoints remain `/mcp/oauth/{authorize,token,register,revoke}`. `/mcp` retains its original plain-GET refusal and protocol behavior.

Separate HTTP tests use the literal production Host header `join.usebeeline.app` against loopback, and verify `/`, `/join`, `/mcp`, SSE and MCP headers, OPTIONS, exact resource URLs, canonical issuer discovery, and rejection of arbitrary/forwarded Host reflection. Integration tests use distinct loopback hostnames for the canonical server and alias, complete OAuth with each resource, then initialize/read/post.

## Validation

- `npm run build` — PASS.
- `npm run typecheck` — PASS after temporarily setting aside ignored local screenshot-source `.tsx` archives under `apps/mobile/evidence/composer-hint-center/local/selectall`; archives restored afterwards. Those files are absent from a clean checkout and CI. Workspace, mobile source and scripts checks also pass independently.
- `npm run test -w @beeline/server -- src/rooms-mcp.test.ts --maxWorkers=2 --minWorkers=1` — 146 passed.
- `npm run test -w @beeline/server -- src/rooms-mcp-join.test.ts --maxWorkers=2 --minWorkers=1` — 7 passed.
- `npm run test -w @beeline/server -- src/app-connections.integration.test.ts --maxWorkers=2 --minWorkers=1 -t onboarding-connect-1` — 4 passed.
- `npm run test --prefix apps/mobile -- run sources/components/buzz/MemberPickerSheet.test.tsx --maxWorkers=2 --minWorkers=1` — 10 passed.
- `node --test scripts/landing-animation.test.mjs scripts/readme.test.mjs` — PASS.
- `git diff --check` — PASS.

## Host setup expected from firstmate

Point `join.usebeeline.app` at the **existing Beeline server Fly application**, provision its Fly certificate, and preserve the HTTP Host header. `/` and `/join` on that host reach the existing MCP service; `/join` on `server.usebeeline.app` also works. Keep `PUBLIC_ORIGIN=https://server.usebeeline.app` and the existing sign-in/OAuth callback configuration. The server constructor defaults to `join.usebeeline.app`; no new production environment setting is added. `BEELINE_JOIN_HOST` is a proof-fixture input passed explicitly to that constructor. Only the configured alias is trusted, and forwarded-host/proto headers never become OAuth URLs. Join-host protected-resource documents name the exact requested join resource and advertise the canonical server origin as the existing issuer. Existing `/mcp` connections keep their URL and credentials.
