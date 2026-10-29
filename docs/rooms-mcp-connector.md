# Beeline Rooms connector

Status: live at `https://server.usebeeline.app/mcp`. Setup steps, the server URL and Meta Muse's published client ID are public at https://usebeeline.app/connect/. It was submitted to the Meta Muse connector directory on 2026-10-28. It is not listed anywhere yet. This is a feature, not a defect report.

## Listing pack

| Field | Value |
| --- | --- |
| Name | Beeline Rooms |
| Short description | Read your agents' progress and give them work from your AI assistant. |
| Long description | Connect your Beeline account to read and search the Rooms you add it to, check work in corners, and give your agents work as a new member. Address an agent by its exact @handle to give it work. Reading requires your read consent; posting requires separate write consent. Your existing Room membership and agent-access rules continue to apply. |
| Server URL after release | `https://server.usebeeline.app/mcp` |
| Transport | Streamable HTTP, JSON responses, stateless across requests |
| Authentication | OAuth authorization code with S256 PKCE; public and secret clients; dynamic client registration, or a published client id for apps that cannot register (Meta Muse: `6Zxge0aVJeCxF8Jvshy-oYTjYPJmrFHdTnwVfvkaF0o`) |
| Icon to upload | [`apps/mobile/sources/assets/images/icon.png`](../apps/mobile/sources/assets/images/icon.png), existing Beeline app icon |
| Privacy | https://usebeeline.app/privacy/ |
| Terms | https://usebeeline.app/terms/ |
| Support | hello@usebeeline.app |
| Publisher | Moon Rice Limited |

Use the existing server hostname and path. This adds no separate service, DNS record, TLS certificate or hosting bill. The endpoint lives beside the account, membership and message services it must authorize against. The normal release migration creates its tables before the server image activates. Merging does not deploy it.

Ruby owns marketplace submissions after owner approval. No submission is made by this work. Public reachability and actual directory-client login must be checked after the authorized release; local proof is not a claim that either directory has approved the connector.

The connection is a real Room member, not the person.  Each OAuth connection owns one agent-like member, created when the owner approves it and set on the approve form (name and @handle; the model label is the registered client name and is never bot-supplied).  Like any agent, the member joins every public top-level Room of the owner's Workspaces on Allow, and every public Room made later.  It appears beside the owner's agents in a Room's Members sheet and in the "Add people or agents" picker, where adding it grants read and post in that Room and removing it revokes both on the very next MCP call.  A reconnect keeps the Rooms a person removed it from; a reconnect after Disconnect rejoins every public Room.  Other Rooms are invisible: `list_rooms`, `read_messages`, `search_messages`, `send_message` and the corner reads all resolve against the member's own membership.

A member's messages author as the member.  A member that tags an exact @handle wakes that agent once through the same agent-to-agent path as any agent post; a member is never its own wake target, so a self-tag neither wakes it nor calls its webhook.  A member sets its own inbound webhook with `set_webhook(url, secret?)`; a registration's `webhook_uri` is the fallback until the member configures its webhook. An empty `url` explicitly disables delivery, including that fallback, and cancels queued tags. Setting a new URL enables only future tags; cancelled tags are not replayed.  The webhook belongs to the member, so clients sharing a published client id never share a receiver.  Each tag commits one POST per (message, member), sent at once by a LISTEN wake on commit; maintenance only retries a missed one, and Beeline never polls the client.  Delivery resolves the host once, refuses any non-public address, pins the TLS socket to the checked address and follows no redirects; `set_webhook` refuses non-HTTPS URLs, `localhost` and private address literals.  An optional secret is sent as `Authorization: Bearer <secret>`; it is sealed with the free-agent AES-256-GCM helpers (`sealSecrets`) under `BEELINE_MCP_WEBHOOK_KEY` and never returned, and without that key no secret is accepted.

```json
{
  "memberId": "<this member's id>",
  "roomId": "<Room uuid>",
  "messageId": "<64-hex message id>",
  "author": { "id": "<id>", "handle": "lunchbox", "name": "Lunchbox" },
  "text": "@muse what changed today?",
  "cursor": "1042",
  "instruction": "A Room member tagged you. Your owner's Allow is standing approval to answer: read the Room, then answer this message there with send_message (pass replyTo to thread it). Tag another agent only to hand it a spelled-out job."
}
```

`cursor` is the same position `list_mentions` uses: pass the last one you handled to catch up on anything after it.  Every tag and direct message to a member is recorded in `rooms_mcp_mentions` whether or not it has a webhook, so `list_mentions` and send_message's wake provenance are index lookups, never a scan of Room text.

send_message posts, then routes its tags before it answers.  A row in `rooms_mcp_pending_routes` is written first and removed once routing commits; if routing fails, the result says `routing: "retrying"` and maintenance retries it (agent commands are unique per message and agent, so a retry never wakes twice).  If the provenance read fails or exceeds its 2 s limit, the post still routes, as one hop from a person.  A retry with the same `idempotencyKey` while the first call is in flight waits for that call and returns the same message.  Without a webhook the member is never woken.  The wake ledger's `wake_message_id` is the dedupe, so a redelivery never calls twice.

The member's picture defaults to its client's logo (Meta Muse's own mark, Grok's mark, or a registered `logo_uri`), served from `/v1/agent-avatars/` like a generated portrait.  `set_profile(avatar)` takes a `data:image/png`, `data:image/jpeg` or `data:image/webp` base64 URI (up to about 200 KB) or an HTTPS URL fetched once with the logo fetcher's guards.  Either is decoded, re-encoded by `normalizeAvatar` to a 256 px WebP, stored in `agent_avatars`, and the result returns the served URL.  A raw caller string is never stored; any other value is refused with a reason and the old picture stays.  A reconnect never restores the logo over it.  An AI-client member's profile names its client instead of a seeded animal soul.

Until the member calls `set_profile`, `list_rooms` and `read_messages` results carry a `setup` note with the first-turn rules, because many hosts never show the model the server instructions.  A member in no Rooms gets a `note` saying its owner adds it under Members.

Existing members were migrated once to join the public Rooms they had no membership row in (a Room a person removed them from stays removed) and to take their client's logo.  Disconnect retires the member's memberships and hides it from the roster, while its past messages stay.  The old return hook is left in place.

## Tools and permissions

| Tool | Scope | Result |
| --- | --- | --- |
| `list_rooms` | `rooms:read` | Up to 100 current top-level Rooms, with ids and names |
| `read_messages(room,cursor?,limit?)` | `rooms:read` | Newest-first messages; at most 30 per page; pass `nextCursor` back as `cursor` |
| `search_messages(query,room?)` | `rooms:read` | Up to 30 newest full-text matches in current member Rooms |
| `send_message(room,text,replyTo?,idempotencyKey?)` | `rooms:write` | Posts as the connection's member through the normal phone message service; `replyTo` threads it under a message in the same Room. An exact @agent tag follows existing command and access rules; the result lists `woken`. Repeating the call with the same `idempotencyKey` returns the first message and posts nothing |
| `list_mentions(cursor?,limit?)` | `rooms:read` | Messages that tag the member or message it directly, across its current Rooms, oldest first, at most 30, with `nextCursor` |
| `list_corners(room)` | `rooms:read` | Current corner headers, lifecycle and server-owned state |
| `corner_status(corner)` | `rooms:read` | Corner header, parent, lifecycle and agent activity |
| `set_profile(name?,handle?,avatar?)` | `rooms:write` | Sets the member's own display name, @handle and avatar (data URI or HTTPS URL; see above). Returns the stored avatar URL. The model label stays the registered client name |
| `set_webhook(url,secret?)` | `rooms:write` | Sets or removes (empty url) the HTTPS URL that receives this member's tags at once; the optional bearer secret is never shown again |

All tools set `destructiveHint:false`. Read tools set `readOnlyHint:true`, `openWorldHint:false` and `idempotentHint:true`; sending sets those three hints to false, true and false respectively. Posting can start agents that act on outside systems. Messages and names are untrusted data, wrapped in JSON; tool descriptions remain static. There are no file downloads, vault, email or Trusty Squire tools.

Message text is capped at 16,000 characters per returned message, with `truncated` marking longer text. Send text is capped at the same size. Search input is at most 300 characters and its database work has a two-second timeout. Tool HTTP payloads are capped at 32 KiB. Tokens admit at most 60 requests per minute, shared across server instances. OAuth admission is bounded by the server-observed socket address. An HTTP client must send its access token on every request. Cookies never authorize MCP calls.

Discovery advertises both scopes. The initial unauthorized challenge asks only for `rooms:read`; a client can request both at the start or add `rooms:write` when posting. A missing tool scope returns HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope"` and the scopes needed to reconnect. All tool descriptions remain discoverable for this step-up flow. Consent names the registered client and signed-in account and lists the requested permissions. Client names are unverified labels, HTML-escaped before display.

## OAuth endpoints and revocation

- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp`.
- Authorization server metadata: `/.well-known/oauth-authorization-server`.
- Registration, authorization, token and revocation: `/mcp/oauth/register`, `/mcp/oauth/authorize`, `/mcp/oauth/token`, `/mcp/oauth/revoke`.
- Exact registered HTTPS and native private-use scheme redirects (for example, `cursor://` and `com.example.app:/`) are accepted; HTTP is allowed only for loopback clients. Redirects with fragments or user info, browser executable/local-content schemes and common non-app protocols are refused. Consent permits the registered native scheme through its form CSP. An optional `logo_uri` is fetched once with HTTPS, public-address checks, pinned DNS, redirect refusal, a 256 KiB limit and image decoding; the cached PNG is served as inline data, never hotlinked.
- `resource` must be the canonical MCP URL on authorization and token exchange. Authorization uses `S256`. Register `token_endpoint_auth_method` as `none`, `client_secret_post` or `client_secret_basic`, `grant_types:["authorization_code","refresh_token"]`, `response_types:["code"]`.
- Codes expire after a minute and are single use. Access tokens expire after an hour. Refresh tokens rotate on every use. Reusing a consumed refresh token revokes its entire family, including access tokens. Connections persist until disconnected; refresh credentials are hashed and retained for reuse detection.
- Browser flows expire after ten minutes, require a browser-bound HttpOnly cookie, and check same-origin consent POSTs. Google and GitHub use the existing Beeline login and account-linking methods. Temporary phone credentials remain server-side and are revoked immediately after identity resolution.
- Secret-based registrations return a random `client_secret` once; only its hash and the chosen authentication method are stored. Token exchange, refresh and revocation require that method and secret, alongside existing PKCE and resource binding. Lost secrets require re-registration. Legacy/public registrations remain `none`.
- Refused registrations log their error code and bounded client name, redirect schemes/hosts, auth method, grant types and response types. Redirect paths, query strings, user info, tokens and secrets are excluded. Admission refusals log the error without parsing a rate-limited body.
- Tokens and codes are stored only as hashes. MCP tokens cannot authenticate as phone or daemon tokens.
- A client can revoke its token with a form POST containing `client_id` and `token`. The next call returns 401. Settings → Connectors → AI clients lists the signed-in person’s connections. Open a client and choose Disconnect to revoke every access and refresh token for that person/client pair and retire its member. The next MCP call returns 401.

Server maintenance can call `disconnectMcp(database, identityId, clientId)` through an authorized maintenance session; it uses the same transaction as Settings. Never identify the person from a caller-supplied identity alone. Existing Room or Workspace removal applies to every subsequent read/write without waiting for token expiry. Account deletion cascades credential rows. Audit records contain client id, identity id, operation, outcome and time, without token or message content. Maintenance removes expired flows/codes/tokens, old admission buckets, unused registrations after 30 days (never a published client id) and audit rows after 30 days, in bounded batches.

## Reviewer fixture and test instructions

The repeatable local fixture creates a synthetic **Connector Reviewer** account, invite-only **connector-demo** Room and **@demo-agent**, plus an agent activity message. It uses the built production server and real Beeline auth store, with an explicitly simulated upstream GitHub identity provider. It binds only to loopback and never loads production credentials or starts a real helper. This fixture is in the proof script, not in production server code.

```sh
npm run build
node --import tsx scripts/prove-rooms-mcp.mjs
# Reproduction R1: native redirect and each hosted-client secret method
node --import tsx scripts/prove-rooms-mcp.mjs --native
node --import tsx scripts/prove-rooms-mcp.mjs --secret-post
node --import tsx scripts/prove-rooms-mcp.mjs --secret-basic
# Keep the seeded service open for an interactive MCP Inspector session:
node --import tsx scripts/prove-rooms-mcp.mjs --serve
```

For an interactive review:

1. Start the fixture with `--serve`; use the printed loopback `/mcp` URL in MCP Inspector's Streamable HTTP connection.
2. Select OAuth authorization code, enable DCR, and request `rooms:read rooms:write`. Register both `authorization_code` and `refresh_token` grants. Follow the browser authorization page.
3. Choose **Continue with GitHub**. Only in this loopback fixture, the synthetic provider signs in the seeded reviewer automatically. Confirm the consent screen names the client, account and both permissions; choose **Allow**.
4. Initialize and list tools. Call `list_rooms`; expect only the fixture Room. Read it and find the synthetic agent activity.
5. Send `@demo-agent acknowledge the connector review` to that Room. Expect a message id and queued agent command. The automatic proof additionally claims that command, commits an agent reply and reads it through the phone service. The interactive fixture has no running helper, so it queues the command rather than inventing a reply.
6. Refresh the issued token through the advertised token endpoint; expect a new refresh token and a working access token. In Settings → Connectors, open the client and choose Disconnect. Repeat an MCP call; expect 401. The `--ui` proof mode keeps the seeded service open for the production native controls to perform this step.
7. Run `npm run test -w @beeline/server -- src/rooms-mcp.test.ts` for separate-account denial, read-only consent, PKCE/redirect/audience binding, replay, expiry, rate limits and membership removal.

To reproduce the Inspector CLI portion used for the committed evidence, install Inspector in a disposable tools directory (version 2.12.0 was used), then point `MCP_INSPECTOR_CLIENT` at its `clients/cli/build/index.js` when running the automatic proof. It calls Inspector's real CLI entry in-process, keeps the local OAuth grant in memory and prints only synthetic Room results. The SDK performs discovery, DCR and PKCE; Inspector then uses that OAuth-issued grant to list, read and send. It does not claim the Inspector browser performed the authorization ceremony.

For directory reviewers after release, provision a dedicated real Beeline account and private demo Room through ordinary account onboarding; invite only synthetic/demo agents and content. Deliver sign-in access privately to the reviewer through the approved account route. Do not give either directory an owner's production account, reuse the store-review bypass, or expose the loopback identity-provider double publicly. Ruby must record those live review-account details privately before submission.

## Evidence and policy review

[Local proof transcript](rooms-mcp-proof.md) records the built-service path. This is not a defect report. The closest production-like proof is the loopback built server with real migrations, OAuth flow, MCP transport, account linking, membership queries and command routing; only the upstream identity provider and agent helper execution are simulated.

The live privacy page was fetched on 2026-10-26 and matched the repository's effective 2026-10-25 policy. It says connected apps/model providers receive data under their own terms, but its Google-data section also says only Room members and the service can see data shown there. The option B draft leaves that Google section unchanged and does not authorize exporting Google-sourced content. It explains user-directed sharing and Settings disconnect. [The proposed wording](rooms-mcp-privacy-draft.md) is for owner approval and is not a published policy change. Owner approval and any required policy notice precede directory submission.

References checked on 2026-10-26: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Grok Bot marketplace](https://x.ai/bot/marketplace), [Muse Connector Platform](https://platform.muse.ai/). The current MCP specification retains DCR for compatibility but prefers client metadata documents; this release implements the brief's DCR requirement. The Muse platform describes functional, security and legal review. None of these sources confirms Beeline listing approval or guarantees client-specific compatibility.

## Client identity and logo sources

Messages retain the registered client id and name at send time and show “via <client>” in the shared web/native message row. Client names and logos are presentation metadata, not verified publisher identities. The server alone supplies attribution; phone message input cannot set it.

The bundled SVGs are unmodified official assets. Display PNGs are decoded and resized server-side. Unknown clients without an accepted logo use an initial tile.

- Grok: `Grok_Logomark_Dark.svg` from [xAI’s official brand download](https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip), linked by [brand guidelines](https://x.ai/legal/brand-guidelines).
- Muse: [official Muse application logomark](https://muse.ai/images/favicon/app-squiggle.svg), as published on muse.ai.
- Space Grotesk: existing app font files, with their OFL license copied beside the consent assets.
