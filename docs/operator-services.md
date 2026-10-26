# Operator finances

This is a feature, not a defect report. The frontend is in
`Beeline-Work/beeline-dashboard`, corner `8891ee39-1fd9-47c1-88c0-69e022da45db`.

The dashboard-secret-only `GET /v1/admin/dashboard` adds `finances`.
`operator-finances.ts` owns collection and projection; `operator-dashboard-services.ts`
owns the inventory and balance reads. Provider failures stay on the affected row.
The existing dashboard sections and authentication are unchanged.

## Contract (PR A)

The authoritative typed contract is `apps/server/src/operator-finances-contract.ts`.
The collector return annotation enforces it. `docs/fixtures/operator-finances.json`
is exported by the built HTTP proof. Notify the frontend owner before any shape change.

`perUser` is `{state: pending, delivery: PR B, users: [], note}` until attribution ships.


`finances` has `schemaVersion: 1`, `timeZone: UTC`, `currency: USD`, `measuredAt`,
`cacheSeconds: 600`, `month` and `previousMonth` (YYYY-MM), `snapshotState`
(`saved` / `unavailable`), `summary`, `services`, `daily`, `perUser`, and `note`.
If collection as a whole fails, it uses the existing section-unavailable shape.

A money metric is `{usd: number|null, source: API|metered|entered|unknown,
state: measured|partial|stale|unknown, measuredAt: string|null, note: string}`.
Never render null as zero. Every source must remain visible beside its amount. Unknown sources use the explicit `unknown` tag.
`partial` is a known subset, not a service invoice. `stale` preserves a previously
saved observation with its original timestamp after a failed refresh. Estimates
and projections retain their source and explanatory note.

`summary.monthToDate`, `summary.projectedMonth`, `summary.lastMonth` each have
`{usd, knownUsd, measuredServices, totalServices, state}`. `usd` is null unless
all services have complete measured amounts; `knownUsd` is the sum of available
subsets, labelled **Known spend**, never total burn. Both can be null.
`averageCostPerActiveUser` is an unknown money metric until PR B.

Every `services` row has `id`, `name`, `powers`, `envVars` (names only), `billing`
(`credits` / `pay-as-you-go card` / `fixed plan` / `free`), `billingUrl`,
`balanceNote`, `state` (`measured` / `unavailable` / `no_balance_api`), `readings`,
and `spend: {monthToDate, projectedMonth, lastMonth}` (money metrics). Each row has
`error: string|null`, a sanitized explanation of missing spend or failed balance reads.
`balanceHealth` is `low`, `unreadable`, `ok`, or `not_applicable`; low takes
precedence over unreadable. Keep each reading's error visible even when another
reading in the same row succeeds.

A balance reading has `{label, source, state, value, unit: USD, measuredAt, low,
note}`. `source` is the fixed provider endpoint (never contains an account ID,
key, prefix or query token). `low` is true at or below USD 5 for OpenRouter.
Fly credit has `low: null`: zero prepaid credit does not mean a card-billed account
is unhealthy. Each workload key has a separate account-credit and key-allowance
reading. Never sum account balances: multiple keys can share the same account.

`daily` is an array of `{date: YYYY-MM-DD, services: [{serviceId, usd, source,
measuredAt}]}` covering the current UTC month to date and the previous two calendar
months. Missing days remain null. Never draw null gaps as measured zero.
Use service IDs to join the daily points to names. API history wins over the
free-agent model subset on overlapping days, never sum both sources.

Projection uses MTD / fractional elapsed UTC days * calendar days in month.
Fixed recurring costs accrue evenly over each calendar month; their projection
is the configured monthly cost. The trend uses entered daily amortization, not
an assertion about the invoice payment date. At the exact start of a month the
projection is unknown until there is elapsed time.

## Collection and durability

The leader collects hourly without blocking other background jobs; reads also
refresh on demand. Each process coalesces concurrent reads and caches successful
or failed provider results for ten minutes. Each provider HTTP call has a five
second timeout and refuses redirects. Balance reads and spend reads are independent.

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

## Frontend field names frozen for the priority contract handoff

`headline` exposes nullable `monthToDateUsd`, `projectedMonthUsd`, `lastMonthUsd`,
`avgCostPerActiveUserUsd`, `activeUsers`, and timestamp `asOf`.
The first three mirror complete `summary` totals. When incomplete, use the
explicitly labelled `summary.*.knownUsd` subtotal. Attribution counts stay null
until PR B, rather than reporting a fictitious empty population.

Service rows additionally expose `category` (`models|voice|hosting|other`),
`billingType` (`credits|card_monthly|fixed_plan|free`), flat nullable
`monthToDateUsd`, `projectedMonthUsd`, `lastMonthUsd`, `balanceUsd`, and `readAt`.
`sources` has one tag per flat amount (`api|metered|entered|unknown`). Flat fields
mirror the detailed spending metrics. `balanceUsd` is only for an unambiguous
single account-credit observation, never a key allowance or a sum across accounts.
Multiple account readings remain separate under `readings`. Each has its own
measurement time. Rows retain sanitized `error` and provider `billingUrl`.

Each `daily` point also has nullable `models`, `voice`, `hosting`, `other` amounts.
A category stays null if its services lack complete observations; the detailed
per-service series retains known subsets. OpenRouter is categorized as models,
including voice reply generation; Cloudflare and Groq are categorized as voice;
Fly/Neon/Tigris as hosting. This is service categorization, not token attribution.

The fixed `perUser` shape now includes `state`, `delivery`, nullable `activeUsers`,
`attributedShare`, `attributedUsd`, `unattributedUsd`, `fixedCostPerActiveUserUsd`,
and `users` with `{handle,modelsUsd,voiceUsd,machineUsd,variableUsd,fixedUsd,totalUsd}`.
All user amounts are nullable. In PR A it is pending with no users and all numbers
null; `delivery` says PR B. Earlier nested `summary`/`spend` fields remain available.

`apps/server/src/operator-finances-contract.fixture.json` is a synthetic UI fixture
beside the types: mixed API, metered and entered sources, failed Fly billing,
unknown totals, realistic daily category points, and explicit per-user unknowns.
It is example data, never production costs or recurring invoice configuration.
The independent `docs/fixtures/operator-finances.json` is still exported from
the built HTTP path with provider fixtures for integration verification.
