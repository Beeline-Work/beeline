# Beeline Rooms connector

Status: implementation and local reviewer fixture; not deployed or submitted by this change. This is a feature, not a defect report.

## Listing pack

| Field | Value |
| --- | --- |
| Name | Beeline Rooms |
| Short description | Read your agents' progress and give them work from your AI assistant. |
| Long description | Connect your Beeline account to read and search the Rooms you belong to, check work in corners, and send messages as yourself. Address an agent by its exact @handle to give it work. Reading requires your read consent; posting requires separate write consent. Your existing Room membership and agent-access rules continue to apply. |
| Server URL after release | `https://server.usebeeline.app/mcp` |
| Transport | Streamable HTTP, JSON responses, stateless across requests |
| Authentication | OAuth authorization code with S256 PKCE; public clients; dynamic client registration |
| Icon to upload | [`apps/mobile/sources/assets/images/icon.png`](../apps/mobile/sources/assets/images/icon.png), existing Beeline app icon |
| Privacy | https://usebeeline.app/privacy/ |
| Terms | https://usebeeline.app/terms/ |
| Support | hello@usebeeline.app |
| Publisher | Moon Rice Limited |

Use the existing server hostname and path. This adds no separate service, DNS record, TLS certificate or hosting bill. The endpoint lives beside the account, membership and message services it must authorize against. The normal release migration creates its tables before the server image activates. Merging does not deploy it.

Ruby owns marketplace submissions after owner approval. No submission is made by this work. Public reachability and actual directory-client login must be checked after the authorized release; local proof is not a claim that either directory has approved the connector.

## Tools and permissions

| Tool | Scope | Result |
| --- | --- | --- |
| `list_rooms` | `rooms:read` | Up to 100 current top-level Rooms, with ids and names |
| `read_messages(room,cursor?,limit?)` | `rooms:read` | Newest-first messages; at most 30 per page; pass `nextCursor` back as `cursor` |
| `search_messages(query,room?)` | `rooms:read` | Up to 30 newest full-text matches in current member Rooms |
| `send_message(room,text)` | `rooms:write` | Posts as the signed-in person through the normal phone message service; exact @agent tags follow existing command and access rules |
| `list_corners(room)` | `rooms:read` | Current corner headers, lifecycle and server-owned state |
| `corner_status(corner)` | `rooms:read` | Corner header, parent, lifecycle and agent activity |

All tools set `destructiveHint:false`. Read tools set `readOnlyHint:true`, `openWorldHint:false` and `idempotentHint:true`; sending sets those three hints to false, true and false respectively. Posting can start agents that act on outside systems. Messages and names are untrusted data, wrapped in JSON; tool descriptions remain static. There are no file downloads, vault, email or Trusty Squire tools.

Message text is capped at 16,000 characters per returned message, with `truncated` marking longer text. Send text is capped at the same size. Search input is at most 300 characters and its database work has a two-second timeout. Tool HTTP payloads are capped at 32 KiB. Tokens admit at most 60 requests per minute, shared across server instances. OAuth admission is bounded by the server-observed socket address. An HTTP client must send its access token on every request. Cookies never authorize MCP calls.

Discovery advertises both scopes. The initial unauthorized challenge asks only for `rooms:read`; a client can request both at the start or add `rooms:write` when posting. A missing tool scope returns HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope"` and the scopes needed to reconnect. All tool descriptions remain discoverable for this step-up flow. Consent names the registered client and signed-in account and lists the requested permissions. Client names are unverified labels, HTML-escaped before display.

## OAuth endpoints and revocation

- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp`.
- Authorization server metadata: `/.well-known/oauth-authorization-server`.
- Registration, authorization, token and revocation: `/mcp/oauth/register`, `/mcp/oauth/authorize`, `/mcp/oauth/token`, `/mcp/oauth/revoke`.
- Exact registered HTTPS redirects are accepted; HTTP is allowed only for loopback clients. URL fetching is never part of registration.
- `resource` must be the canonical MCP URL on authorization and token exchange. Only `authorization_code` and `S256` are supported. Register `token_endpoint_auth_method:"none"`, `grant_types:["authorization_code"]`, `response_types:["code"]`.
- Codes expire after a minute and are single use. Access tokens expire after an hour. This version issues no refresh token; reconnect after expiration. Clients requiring refresh tokens must be verified before directory submission.
- Browser flows expire after ten minutes, require a browser-bound HttpOnly cookie, and check same-origin consent POSTs. Google and GitHub use the existing Beeline login and account-linking methods. Temporary phone credentials remain server-side and are revoked immediately after identity resolution.
- Tokens and codes are stored only as hashes. MCP tokens cannot authenticate as phone or daemon tokens.
- A client can revoke its token with a form POST containing `client_id` and `token`. The next call returns 401. There is no app settings control in this version.

Support can revoke all grants for a person/client pair using the authorized server database maintenance route, with bound parameters:

```sql
BEGIN;
DELETE FROM rooms_mcp_flows WHERE identity_id=$1 AND client_id=$2;
DELETE FROM rooms_mcp_codes WHERE identity_id=$1 AND client_id=$2;
UPDATE rooms_mcp_tokens SET revoked_at=now() WHERE identity_id=$1 AND client_id=$2;
COMMIT;
```

Identify the person through the support authentication process, never from a caller-supplied identity alone. Existing Room or Workspace removal applies to every subsequent read/write without waiting for token expiry. Account deletion cascades credential rows. Audit records contain client id, identity id, operation, outcome and time, without token or message content. Maintenance removes expired flows/codes/tokens, old admission buckets, unused registrations after 30 days and audit rows after 30 days, in bounded batches.

## Reviewer fixture and test instructions

The repeatable local fixture creates a synthetic **Connector Reviewer** account, invite-only **connector-demo** Room and **@demo-agent**, plus an agent activity message. It uses the built production server and real Beeline auth store, with an explicitly simulated upstream GitHub identity provider. It binds only to loopback and never loads production credentials or starts a real helper. This fixture is in the proof script, not in production server code.

```sh
npm run build
node --import tsx scripts/prove-rooms-mcp.mjs
# Keep the seeded service open for an interactive MCP Inspector session:
node --import tsx scripts/prove-rooms-mcp.mjs --serve
```

For an interactive review:

1. Start the fixture with `--serve`; use the printed loopback `/mcp` URL in MCP Inspector's Streamable HTTP connection.
2. Select OAuth authorization code, enable DCR, and request `rooms:read rooms:write`. Register only the `authorization_code` grant. Follow the browser authorization page.
3. Choose **Continue with GitHub**. Only in this loopback fixture, the synthetic provider signs in the seeded reviewer automatically. Confirm the consent screen names the client, account and both permissions; choose **Allow access**.
4. Initialize and list tools. Call `list_rooms`; expect only the fixture Room. Read it and find the synthetic agent activity.
5. Send `@demo-agent acknowledge the connector review` to that Room. Expect a message id and queued agent command. The automatic proof additionally claims that command, commits an agent reply and reads it through the phone service. The interactive fixture has no running helper, so it queues the command rather than inventing a reply.
6. Revoke the token through the advertised endpoint. Repeat an MCP call with that same token; expect unauthorized.
7. Run `npm run test -w @beeline/server -- src/rooms-mcp.test.ts` for separate-account denial, read-only consent, PKCE/redirect/audience binding, replay, expiry, rate limits and membership removal.

To reproduce the Inspector CLI portion used for the committed evidence, install Inspector in a disposable tools directory (version 2.12.0 was used), then point `MCP_INSPECTOR_CLIENT` at its `clients/cli/build/index.js` when running the automatic proof. It calls Inspector's real CLI entry in-process, keeps the local OAuth grant in memory and prints only synthetic Room results. The SDK performs discovery, DCR and PKCE; Inspector then uses that OAuth-issued grant to list, read and send. It does not claim the Inspector browser performed the authorization ceremony.

For directory reviewers after release, provision a dedicated real Beeline account and private demo Room through ordinary account onboarding; invite only synthetic/demo agents and content. Deliver sign-in access privately to the reviewer through the approved account route. Do not give either directory an owner's production account, reuse the store-review bypass, or expose the loopback identity-provider double publicly. Ruby must record those live review-account details privately before submission.

## Evidence and policy review

[Local proof transcript](rooms-mcp-proof.md) records the built-service path. This is not a defect report. The closest production-like proof is the loopback built server with real migrations, OAuth flow, MCP transport, account linking, membership queries and command routing; only the upstream identity provider and agent helper execution are simulated.

The live privacy page was fetched on 2026-10-26 and matched the repository's effective 2026-10-25 policy. It says connected apps/model providers receive data under their own terms, but its Google-data section also says only Room members and the service can see data shown there. External-client exports need explicit clarification. [The proposed wording](rooms-mcp-privacy-draft.md) is for owner approval and is not a published policy change. Owner approval and any required policy notice precede directory submission.

References checked on 2026-10-26: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Grok Bot marketplace](https://x.ai/bot/marketplace), [Muse Connector Platform](https://platform.muse.ai/). The current MCP specification retains DCR for compatibility but prefers client metadata documents; this release implements the brief's DCR requirement. The Muse platform describes functional, security and legal review. None of these sources confirms Beeline listing approval or guarantees client-specific compatibility.
