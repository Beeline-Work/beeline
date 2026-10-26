# Operator finances

This is a feature, not a defect report. The frontend is in
`Beeline-Work/beeline-dashboard`, corner `8891ee39-1fd9-47c1-88c0-69e022da45db`.

The dashboard-secret-only `GET /v1/admin/dashboard` adds `finances`.
`operator-finances.ts` owns collection and projection; `operator-dashboard-services.ts`
owns the inventory and balance reads. Provider failures stay on the affected row.
The existing dashboard sections and authentication are unchanged.

## Fixed dashboard contract (PR A)

The wire shape exactly matches `Beeline-Work/beeline-dashboard` commit `bafb528`,
`public/finances-data.js` and `test/fixtures/finances/dashboard.json`.
Authoritative TypeScript: `apps/server/src/operator-finances-contract.ts`.
The dashboard example fixture is copied alongside it as
`apps/server/src/operator-finances-contract.fixture.json`. All amounts in that
fixture are synthetic UI examples, never verified invoices.

`finances = {month, measuredAt, totals, daily, services}`. No additional fields
are emitted. `month` is YYYY-MM; `measuredAt` is an ISO timestamp.
`Money = {value: number|null, source: api|metered|entered|unknown}`.
Null means unknown; never turn it into zero. `unknown` always has a null value.

`totals = {mtd, projected, lastMonth, perActiveUser}` uses Money for every field.
A full total stays unknown until all service costs are complete. This contract
has no subtotal slot, so partial known spend is shown only on its service row.
`perActiveUser` is unknown until PR B; there is no separate per-user block in this
fixed first-release contract.

`daily = [{date, models, voice, hosting, other}]` covers this UTC month through
today and the previous two calendar months. Each category uses Money. Missing
or incomplete category observations remain unknown, never a zero-filled line.
OpenRouter is models (including reply generation for voice); Cloudflare and Groq
are voice; Fly, Neon and Tigris are hosting; remaining services are other.

Each service is `{id, name, powers, billing, billingUrl, state, mtd, projected,
lastMonth, balance}`. Billing is `credits|pay-as-you-go card|fixed plan|free`.
State is `ready|unavailable`; unavailable means no usable financial reading.
The three spending fields use Money. Partial scope is stated in `powers`.
Projections are calculated estimates, tagged `metered`.

For credit services, `balance` is `{value, source, measuredAt, low}`; account
balances at or below USD 5 are low. A denied or ambiguous multi-account balance
has unknown Money, null measurement time and low false. For other services,
`balance` is null. A key allowance is not an account credit balance. Fly prepaid
credit remains internal because the fixed UI contract only shows credit-service
balances. Provider responses, key names/values/prefixes and errors are not emitted.
No field differs from the dashboard shape.

`operator-finances-wire.ts` is the single adaptation from private collection
metadata in `operator-finances-details.ts`. The typed return and focused contract
test prevent accidental wire fields. `npm run prove:operator-finances` builds the
server and requests the actual authenticated HTTP route in isolation, exporting
`docs/fixtures/operator-finances.json` from that response. Notify the UI corner
before any later wire-shape change.

## Collection and durability

The leader collects hourly without blocking other background jobs; reads also
refresh on demand. Each process coalesces concurrent reads and caches successful
or failed provider results for ten minutes. Each provider HTTP call has a five
second timeout and refuses redirects. Balance reads and spend reads are independent. Internal failure details never cross the fixed wire boundary.

`operator_finance_snapshots` persists date/service/scope/source, observed daily
cost, observed MTD cost and read time. It stores no provider response or identity.
Upserts are monotonic by measurement time and never replace known data with null.
Only the requested three calendar months are read. Data is not deleted when a
provider's history window expires. Snapshots do not backfill unknown days, infer
cost from credit top-ups, or manufacture an invoice from a partial period.
Snapshots of today's provider usage remain partial: an early observation does
not prove a complete UTC day. Provider-specific partial notes remain visible.

`operator-finances-config.ts` is the checked-in recurring invoice configuration.
Unverified invoice amounts are null. To enter a verified cost, supply `monthlyUsd`
and its actual effective date range. No example price is treated as an invoice.
Overage costs stay unknown unless a separate measured source exists.

## Inventory evidence and data gaps

| Service | Powers / evidence | Spend source | Balance source / missing permission |
| --- | --- | --- | --- |
| OpenRouter | Free-agent model proxy; voice-service.ts; institutional-memory-embeddings.ts | API `/api/v1/key` usage_monthly + usage_daily for unique configured server keys; metered settled free_agent_events fallback | `/credits` requires management key; `/key` allowance works with inference key |
| Cloudflare | voice-providers.ts (Deepgram Flux/Aura on Workers AI); hosting | API account billable-usage, Billing Read permission; account-wide variable charges only | No remaining-credit API for direct Workers AI billing |
| Groq | speech-transcription.ts | Unknown; no persisted billed audio duration yet | No documented balance API |
| Fly | fly.beeline-server.toml, free-agent machines, self-hosted LiveKit | Unknown; deployment/machines tokens do not provide an invoice | GraphQL organization.creditBalance in cents; verified against live schema |
| Neon | database.ts (PostgreSQL) | Unknown; consumption API needs Neon management API key, DATABASE_URL cannot authenticate it | No balance with database connection credentials |
| Tigris | object-storage.ts | Unknown | No balance API with S3 object credentials |
| Sentry | sentry.ts; release actions | Entered config, currently unknown | DSN only ingests errors; usage needs organization management access |
| APNs | apns-push.ts | Entered zero, free notification delivery | None |
| Web Push | web-push.ts | Entered zero, free delivery | None |
| Apple Developer | signing and store release actions | Entered annual invoice / 12, currently unknown | None |
| Domains | service hostnames and Cloudflare DNS | Entered renewal invoices / 12, currently unknown | None |
| Expo EAS | release actions and app configuration | Entered config, currently unknown | CI token is not available to the server |
| GitHub | GitHub App, repository operations, CI | Entered config, currently unknown | Installation token cannot read organization billing |
| Composio | composio-apps.ts and index.ts | Unknown; project usage API counts executions, does not supply prices/credits | None |
| Telegram | sentry-telegram.ts | Entered zero, free bot messaging | None |
| Coinbase CDP | cdp-client.ts; evm-chain.ts | Unknown; user transactions are not provider expense | User token balances are private, no single Beeline operating wallet |
| Link | link-agent-wallet.ts | No provider operating charge recorded; free integration | User payment sources are private, not Beeline credit |

Direct Deepgram, ElevenLabs, Fal, Twilio, Resend and Stripe API calls were not
found in production server code at 248f32840. Company catalog entries and tools
in an owner's vault do not establish a product dependency. Deepgram speech is
billed by Cloudflare, Link is the payment integration, not a direct Stripe API.
OpenAI, Anthropic and Gemini are helper-selectable model providers, not direct
server inference dependencies; server model invoices flow through OpenRouter.
No new keys or accounts are provisioned by this change.

References:
- [OpenRouter current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
- [OpenRouter account credits, management key required](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
- [OpenRouter activity, completed thirty UTC days and management key](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity-grouped-by-endpoint)
- [Cloudflare billable usage, Billing Read token](https://blog.cloudflare.com/billable-usage-api)
- [Groq billing](https://console.groq.com/docs/billing-faqs)
- [Neon API authentication](https://api-docs.neon.tech/reference/authentication)
- [Composio usage counts](https://docs.composio.dev/reference/api-reference/organization)
- [CDP token balances](https://docs.cdp.coinbase.com/wallet-api-v2/docs/token-balances)

Additional direct dependencies found during the code inventory: Google/Firebase
(Android push and Play reports: firebase-push.ts, store-download-reports.ts), MCP
Registry (mcp-registry.ts), and public blockchain RPC services PublicNode, Base,
Arbitrum, Optimism, Zora and Avalanche (evm-chain.ts). Their public endpoints have
no operating credit account; rows show entered zero for the public service only,
not user gas or token costs. These are separate rows so wallet outages have a
named dependency. Google billing for other Cloud products is not included.
