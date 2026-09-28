# @beeline/server

Beeline's production monolith is one framework-free TypeScript process backed by one PostgreSQL database. It serves the token-authenticated phone and daemon contracts, mounts the GitHub identity routes, and owns monolith GitHub App callbacks and webhooks.

## Surfaces

- `/v1/auth/github/exchange`, `/v1/auth/refresh`: opaque phone access and rotating refresh tokens.
- `/v1/auth/github/reconnect`: authenticated replacement of the current
  identity's server-side GitHub credential from a fresh, same-subject GitHub
  ticket; an account mismatch returns `409` and leaves the phone session intact.
- `/v1/avatars/:id`: public, unguessable, non-enumerable URLs for immutable, durable Workspace-avatar WebP bytes; owner/admin writes remain authenticated.
- `/v1/auth/daemon/exchange`: one-use exchange into an opaque daemon token.
- `/v1/phone/*`: the complete indexed phone read surface, named writes from `@beeline/api-contract/phone`, read marks, media, GitHub room tokens, push registration, and OTA receipts.
- `/v1/phone/live`: authenticated WebSocket invalidation plus draft, thought, and presence overlays.
- `/v1/daemon/operations/:name`: only names in `DaemonOperationMap`. There is no event filter, event query, or generic publish endpoint.
- `/v1/releases/helper-minimum`: release-secret-authenticated, per-Machine live raise of the minimum helper version.
- `/v1/github/install/callback`: one-use GitHub App installation completion.
- `/v1/github/webhook`: signature-checked, delivery-ID-deduplicated GitHub events.
- `/healthz`: process health.

All state shared by the two configured Fly Machines is in PostgreSQL. At boot, the server reads PostgreSQL's `max_connections`, reserves at least six connections for releases and operations, and divides the remainder across `BEELINE_SERVER_MACHINES` (default two). Within each machine's budget it caps the app pool at `DATABASE_POOL_MAX` (default five), then allocates enrichment, diagnostics, two job slots, and one separate listener. `/health` reports the measured budget and pressure in each pool. One jobs connection elects the sole push/maintenance owner; its peer takes ownership when the connection dies. The listener uses a session-persistent connection for cross-machine live fanout. Set `DATABASE_LISTENER_URL` when `DATABASE_URL` points through a transaction pooler; it must be a direct PostgreSQL connection string.

Set `BEELINE_MIN_HELPER_VERSION=vX.Y.Z` to enforce a minimum helper release at boot. A helper sends `x-beeline-helper-version` on every daemon HTTP POST and `helperVersion` plus `sourceSha` in its live WebSocket URL; the socket hello echoes the reported helper identity. Once a minimum is active, missing or older versions receive HTTP `426 {"error":"update_required","minVersion":"vX.Y.Z"}` before authentication or database access. A connected older helper receives `{"type":"force-update","minVersion":"vX.Y.Z"}` and the socket closes with code `1008`. Before raising a minimum, deploy helpers that send these fields; earlier servers ignore them. The release owner may raise the minimum without restarting a Machine by POSTing `{"minVersion":"vX.Y.Z"}` to `/v1/releases/helper-minimum` with `BEELINE_RELEASE_NOTIFY_SECRET` as a bearer token on **each pinned Machine**. The endpoint only raises; set the same environment value for restart persistence. `/version` reports the active minimum so the release owner can verify both Machines.

## Local development

```sh
createdb beeline_server_local
DATABASE_URL='postgresql://USER@localhost/beeline_server_local?host=%2Fvar%2Frun%2Fpostgresql' \
  NODE_ENV=development npm run dev -w @beeline/server
```

`local:<github-login>` is accepted as the exchange token only outside production. Production mounts `@beeline/auth` on the same listener and consumes GitHub tickets in-process. `PHONE_GITHUB_EXCHANGE_ENDPOINT` is an override for tests and migrations, not a production requirement.

GitHub account/install/repository operations are enabled when `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_SLUG` are all present. `GITHUB_WEBHOOK_SECRET` enables signed webhook intake. Push sending is opt-in with `PUSH_DELIVERY_ENABLED=true`; without it, devices remain registered but no delivery claims are created. Production Fly deployments should set `GOOGLE_APPLICATION_CREDENTIALS_JSON` to the complete Firebase service-account JSON secret. `GOOGLE_CLOUD_PROJECT` optionally overrides the project ID from that JSON. Other environments may use Application Default Credentials, including a file selected by `GOOGLE_APPLICATION_CREDENTIALS`. Startup verifies that the selected credential can mint an access token and fails with a configuration error if it cannot. Never commit the service-account JSON.

Direct iOS delivery uses APNs token authentication. Set `APNS_KEY_P8_BASE64` to the base64-encoded Apple `.p8` key and `APNS_KEY_ID` to its key ID. `APNS_TEAM_ID` defaults to `89KT3SWYAF`, `APNS_BUNDLE_ID` defaults to `app.usebeeline.mobile`, and `APNS_ENVIRONMENT` accepts `production` (the default) or `sandbox`. If `APNS_KEY_P8_BASE64` is absent, iOS delivery remains disabled while Android Firebase delivery continues. Never commit the APNs key.

The mounted auth routes also require `PUBLIC_ORIGIN`, `BUZZY_AUTH_TENANTS_JSON`, and the six `BUZZY_AUTH_OIDC_*` values documented in `apps/auth/README.md`. The tenants JSON must contain an entry whose host and origin match `PUBLIC_ORIGIN`; production uses `server.usebeeline.app`.

Managed app sign-in uses a server-only `BEELINE_COMPOSIO_API_KEY`. Configure the
provider's callback verifier to `${PUBLIC_ORIGIN}/v1/apps/oauth/verify` before
enabling the API key.
The verifier sends a single-use session URI to the signed-in phone; the server
completes it with that person's Beeline identity ID and checks the exact pending
account and toolkit. The API key, provider credentials, and tool execution stay
on the server. Each Google Workspace product (Gmail, Calendar, Drive, Docs,
Sheets) is a separate app connection. Existing first-party Google grants are
disconnected during schema migration because their OAuth client cannot be
transferred; people must sign in again through Connect an app. The new server
does not use the old token tables. They remain during the rolling update for
older server images and are removed by a later release migration.

Link Agent Wallet uses a separate, per-consumer hosted OAuth grant. Apply for a
[confidential Link OAuth client](https://docs.stripe.com/agentic-commerce/link-agent-wallet/oauth)
with application name **Beeline**, description **Agents request a specific purchase;
the customer approves it in Link before a one-time payment credential is issued**,
and exact production redirect URI
`https://server.usebeeline.app/v1/link/oauth/callback`. Register the matching
local/test origin separately if needed. Set `BEELINE_LINK_CLIENT_ID`,
`BEELINE_LINK_CLIENT_SECRET`, `BEELINE_LINK_PUBLISHABLE_KEY` (`pk_live_...` in
production), and `BEELINE_LINK_TOKEN_KEY` (stable base64-encoded 32 random
bytes) on the server only. Request `payment_methods.agentic userinfo:read`;
the latter lets Workbench state the consumer's US/Canada eligibility. A Stripe
secret API key does not authenticate Link. Agent spend requests use the
consumer OAuth token at `api.link.com`; the server alone stores and refreshes
that encrypted grant. Link's own approval is the purchase decision. The Link
approval card goes to the owner's private Link DM; the agent's wait tool gets
the approved one-time card or Shared Payment Token and can fill ordinary
checkout fields with Squire. Link test mode is selected per spend request and
does not charge the underlying method.

Apps connect through one front door: an agent's `connect_app` or Workbench →
Connect an app. The server chooses the route in a fixed order — an app already
connected in Workbench, managed OAuth for a supported app, then Trusty Squire
with an API key, then Squire in a browser only when the app has no API — and
records each choice in `workspace_app_routes`. An existing Registry MCP
connection remains usable, but new route decisions do not select one. Every
use is authorized as `app:<key>` and recorded in `workspace_app_usage`
(`src/app-connections.ts`).

The browser client is hosted separately at `https://web.usebeeline.app`. Set
`BEELINE_WEB_APP_ORIGINS=https://web.usebeeline.app` in production so the server
answers that exact origin's API preflights and admits its exact
`/beeline/github-callback` app-completion URL. The same origin gate covers the
GitHub completion-recovery endpoints used while the browser popup is open. It does not change
`PUBLIC_ORIGIN`, the GitHub provider callback, app-link hosts, or the landing site at
`https://usebeeline.app`.

```sh
npm run typecheck -w @beeline/server
npm test -w @beeline/server
```

## Import

The importer reads a transaction-consistent old PostgreSQL snapshot directly from `channels`, `channel_members`, `users`, `events`, server-owned read marks, and the auth/GitHub tables. It applies the existing push-gateway `projectEvent` rules. It never discovers data through RoomView HTTP and never selects the relay audit table.

```sh
OLD_DATABASE_URL=postgresql://... \
DATABASE_URL=postgresql://... \
OLD_PUSH_REGISTRY_JSON=/snapshot/registrations.json \
OLD_MEDIA_MANIFEST_JSON=/snapshot/media.json \
npm run import -w @beeline/server
```

`import_runs` and `import_items` make the command restartable with the same `IMPORT_ID`. Media is imported before messages so legacy attachment URLs are rewritten to PostgreSQL-backed `/v1/media/:id` URLs. The command exits `2` if the measured new database reaches the 500,000,000-byte Neon ceiling.

See [credential-ceremony.md](docs/credential-ceremony.md), [import-format.md](docs/import-format.md), and [neon-fit.md](docs/neon-fit.md). `fly.toml` is configuration only; provisioning and deployment are Phase C owner actions.
