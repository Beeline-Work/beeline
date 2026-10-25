# Connector MCP discovery

Feature proof (not a defect report), recorded on 2026-10-25. Identifier: `MCP-DISCOVERY-1`.

## Reproduced

The baseline phone service searched the Registry only for Stripe and Linear. With an isolated owner holding six Fly keys, searching `fly` returned the existing company, but its service page offered no Fly MCP connection. The same isolated fixture produced one Fly row from both baseline and changed service. Production account state was not modified.

## Demonstrated

The browser built the actual search and service screens, shared SettingsRow and company connection action hook against an isolated PGlite owner with six metadata-only keys. Adapters replaced authentication/storage/navigation boundaries and exposed the actual PhoneService over local HTTP. The helper used the existing `installRegistryMcp` implementation against live Fly endpoints and the isolated `RegistryMcpOAuth` rendezvous.

- Search `fly` → one Fly.io company row → service page → Connections / Fly.io / Sign in with Fly MCP. [Before connecting](fly-before-connect.png).
- Tap the MCP row → revalidate the server-owned selection → replace the Squire API app route → await the helper's OAuth link → open Fly's live `/mcp/oauth/authorize` → Fly sign-in with that authorization as its return destination. [Live sign-in](fly-oauth.png). No credentials were submitted and no account authorization/token exchange was performed.
- Search `notion` → the live Registry's `com.notion/mcp` at version `1.0.1`, shown in the original Notion row. The live response carries that exact Registry identity while preserving the original row's position and visible copy. Insightfulpipe's third-party Notion server is omitted when the official server is present. [Registry search](notion-registry.png).
- The existing completed-helper status was injected only into the isolated database to verify the final projection: Fly.io / via Fly MCP, header `fly.io · 1 app · 6 keys`. [Connected projection fixture](fly-connected-projection.png). This image is not proof of a completed live authorization.
- The unchanged search screen, built separately from baseline and changed source for `zznomcpfixture`, had identical pixels (zero differing RGBA channels across a 1279 × 936 viewport).

This substitutes an isolated owner for the real owner's production session because the new branch is not deployed. Fly discovery, OAuth metadata, public-client registration, sign-in page and Registry search are live. Database rows, key labels, authentication and helper dispatch are fixtures. The narrow script below repeats the actual phone → helper → returned OAuth link path without a browser or a production account.

```sh
npm run prove:company-mcp-discovery
```

Regression coverage: `company-mcp-discovery.test.ts` (public DNS/socket pinning, private/mixed addresses, redirects, response limits, timeouts, TTL, challenge discovery); `app-connections.integration.test.ts` (`MCP-DISCOVERY-1`, retained keys, explicit selection, unchanged automatic and Composio routes, namespace ownership); mobile `service.test.tsx` and `connect-app.test.tsx` (existing search navigation and service-row ceremony).

## Search latency

Same host, same isolated six-key owner, actual baseline and changed `searchWorkbenchApps`, no Composio fixture. Each series contains the first cold request followed by four requests against the same process caches. Milliseconds:

| Service | Cold time to first results | Warm samples | Warm median |
| --- | ---: | --- | ---: |
| Baseline | 24 | 11, 10, 8, 6 | 9 |
| Changed | 16 | 8, 9, 9, 7 | 8.5 |

Cold time to the Fly MCP row was **344 ms**, measured separately from the first result. These samples exclude browser debounce and rendering and do not predict production database/provider latency.

First results await no company probe or Registry request. Public discovery is refreshed in a bounded background queue and committed to `connector_discovery_cache`, shared across server instances. Only then does the requesting owner's Workbench receive a live invalidation. The current search re-reads in place, preserving existing row positions and visible descriptions; there is no phone polling. Company probes retain their one-second shared deadline; background Registry requests use the existing ten-second provider deadline. Positive company results live for ten minutes, query and negative results for one minute. Expired answers stay visible while refreshing; a provider outage retains the last successful snapshot.

The stalled-provider regression returns first results before the provider is released and verifies that another PhoneService instance can read the committed result. The exact Notion regression supplies insightfulpipe before `com.notion/mcp`: the third party disappears when the official server exists, and is named by publisher below company rows otherwise. Mobile coverage verifies live refresh without clearing rows or polling. `postgres-live.test.ts` verifies the cache commits before the owner-scoped invalidation.
