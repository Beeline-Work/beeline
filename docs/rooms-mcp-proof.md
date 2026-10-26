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
[ROOMS-MCP-1] Streamable HTTP client initialized, discovered all tools, listed its seeded Room and read synthetic agent activity.
[ROOMS-MCP-1] send_message posted as the reviewer; the tagged demo agent claimed its command and replied; the phone Room read shows the reply.
[ROOMS-MCP-1] MCP Inspector tools/call list_rooms completed through Streamable HTTP using the OAuth-issued local grant.
[ROOMS-MCP-1] MCP Inspector tools/call read_messages completed through Streamable HTTP using the OAuth-issued local grant.
[ROOMS-MCP-1] MCP Inspector tools/call send_message completed through Streamable HTTP using the OAuth-issued local grant.
[ROOMS-MCP-1] Revocation succeeded; the next MCP request returned unauthorized. PASS.
```

Inspector results contained only the synthetic `connector-demo` Room, the seeded activity, the human request, the claimed demo-agent reply, and a new message id from Inspector's send. The proof asserted that the sent author was the seeded person, the tagged agent could claim its command, the agent reply was readable through `PhoneService.readRoom`, and the next call after revocation returned HTTP 401.

`rooms-mcp.test.ts` adds adversarial checks for foreign Room and corner reads/writes, search isolation, missing write consent, exact redirects, PKCE, resource audience, code replay and expiry, token expiry, phone-token separation, rate limits, bounded message paging and membership removal. These are real HTTP requests and SDK calls against the server, backed by the database, rather than isolated inner-function tests.

The public URL is a release target, not live proof. Follow the [reviewer instructions](rooms-mcp-connector.md) for an interactive local fixture and the required live-directory checks after authorized release.
