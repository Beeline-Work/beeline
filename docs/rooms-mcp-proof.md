# Rooms MCP local proof

Feature proof **ROOMS-MCP-1**, recorded 2026-10-26. Not a defect report.

The built server ran on loopback with a fresh PGlite database and real Beeline migrations, auth store, message service and command routing. GitHub was a synthetic upstream identity provider. No production accounts, messages, credentials, helpers or deployment were used. The SDK handled the OAuth ceremony; MCP Inspector (2.12.0) exercised list/read/send with that issued grant. This is not a claim that Inspector's browser UI or either directory completed a live-provider login.

Commands:

```sh
npm run build -w @beeline/server
MCP_INSPECTOR_CLIENT=/tmp/emberus-mcp-inspector/node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js node --import tsx scripts/prove-rooms-mcp.mjs
```

Inspector was installed separately in the disposable tools directory with lifecycle scripts disabled. The proof imports the installed CLI entry; its path is configurable and is not a repository dependency.

Redacted progress transcript (credentials are never printed):

```text
[ROOMS-MCP-1] SDK discovered metadata, dynamically registered, generated S256 PKCE and requested both scopes.
[ROOMS-MCP-1] Built Beeline GitHub login completed, consumed a one-use ticket, and showed the client, account, read scope and write scope on consent. Upstream GitHub is a local test double.
[ROOMS-MCP-1] SDK exchanged the code with PKCE and the resource audience. No credentials are printed or saved.
[ROOMS-MCP-1] SDK refreshed the connection and received a rotated refresh token.
[ROOMS-MCP-1] Streamable HTTP client initialized, discovered all tools, listed its seeded Room and read synthetic agent activity.
[ROOMS-MCP-1] send_message posted as the reviewer; the tagged demo agent claimed its command and replied; the phone Room read shows the reply.
[ROOMS-MCP-1] MCP Inspector tools/call list_rooms completed through Streamable HTTP using the OAuth-issued local grant.
[ROOMS-MCP-1] MCP Inspector tools/call read_messages completed through Streamable HTTP using the OAuth-issued local grant.
[ROOMS-MCP-1] MCP Inspector tools/call send_message completed through Streamable HTTP using the OAuth-issued local grant.
[ROOMS-MCP-1] Settings disconnect: the next MCP call returned 401.
```

Inspector results contained only the synthetic `connector-demo` Room, the seeded activity, the human request, the claimed demo-agent reply, and a new message id from Inspector's send. The proof asserted that the sent author was the seeded person, the tagged agent could claim its command, the agent reply was readable through `PhoneService.readRoom`, and the next call after revocation returned HTTP 401.

`rooms-mcp.test.ts` adds adversarial checks for foreign Room and corner reads/writes, search isolation, missing write consent, exact redirects, PKCE, resource audience, code replay and expiry, token expiry, phone-token separation, rate limits, bounded message paging and membership removal. These are real HTTP requests and SDK calls against the server, backed by the database, rather than isolated inner-function tests.

The public URL is a release target, not live proof. Follow the [reviewer instructions](rooms-mcp-connector.md) for an interactive local fixture and the required live-directory checks after authorized release.

## Revision 2 user-path proof

The built service was exercised again with SDK discovery, DCR, PKCE and refresh rotation, then real MCP Inspector list/read/send. The Android build used the production `AiClientsSection`, message ledger, fonts, modal and phone-operation transport inside the disposable `scripts/rooms-mcp-native-proof.tsx` entry. It fetched the synthetic reviewer’s connection list and messages from the local built server. Tapping Grok → Disconnect sent the actual `/v1/phone/operations/disconnectAiClient` request, removed Grok while preserving Muse, and the held MCP access token failed with 401.

This path caught and fixed a missing HTTP operation allowlist entry that direct service tests had missed. The integration regression now sends the phone HTTP request and expects its normal 204 response, then verifies both access and refresh denial. The browser component proof covers successful disconnect and a network failure that keeps the sheet open with a retry message.

The existing live Connectors screen was verified at `https://web.usebeeline.app` before adding the AI clients section. Screenshots use production controls in a focused harness; they do not claim the entire signed-in production app navigation was exercised. Android uses the emulator’s local-host bridge. OAuth login still uses the explicitly synthetic upstream provider.

Evidence in [`apps/mobile/evidence/rooms-mcp`](../apps/mobile/evidence/rooms-mcp/):

- `web-consent.png`, `android-consent.png`: actual built consent page in desktop Chromium and Android Chrome.
- `web-clients.png`, `web-sheet.png`, `web-message.png`: production web controls and official client marks.
- `android-clients.png`, `android-sheet.png`, `android-message.png`: built native production controls.
- `android-disconnected.png`: the remaining Muse connection and the next-call 401 result.

Run the native harness only against the disposable `--ui` fixture; it contains no production login. Set `MCP_PROOF_PORT` for a stable local port if needed. The proof fixture bootstrap exposes only its synthetic session locally and is never mounted by production server code.
