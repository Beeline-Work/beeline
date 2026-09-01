# Production relay stack (tracked)

This directory preserves the **retired production relay** stack config. Unified
releases no longer deploy it; the monolith server is deployed to Fly.io. It is
NOT the same stack as `relay-stack/compose.yml` + `relay-stack/nginx.conf` one
level up:

|                 | `relay-stack/` (gate)             | `relay-stack/prod/` (this dir)        |
| --------------- | --------------------------------- | ------------------------------------- |
| compose project | `buzzy-gate`                      | `buzz-router-prod`                    |
| purpose         | isolated Phase-0 merge-gate proof | retired production relay reference    |
| deploy path     | `npm run stack:up` (manual/local) | retired; no unified-release deploy    |

Keep them separate on purpose: the gate stack serves the merge-gate proof and
must stay untouched by production deploys; this directory reproduces the
production host's former
`/home/lunchbox/buzz-router-relay-prod/{compose.yml,relay-front/nginx.conf}`
layout for historical and emergency-reference purposes.

## Secrets

Never committed: env files (`$PROJECT_DIR/.env`,
`/home/lunchbox/buzzy-auth/oidc.env`, `beeline-github.env`) and the push
gateway's FCM service-account key live only on the host. This directory holds
paths and defaults only.

## Privileged steps

The retired host promotion and its fixed-argument sudo rules have been removed
from the unified release. Do not restore those permissions for the Fly.io
monolith deployment.

## Materializer topology

Production has one DB-adjacent process. `relay-front` sends `/push/` and the
eight indexer routes to `materializer:8788`; that container hosts push delivery,
repository-event ingestion, and direct bounded Postgres reads over `buzz-net`.
The FCM registry and repository-events signing identity remain on host volumes.

Compose health proves the indexer rejects an unsigned `/workspaces` read with
`401`; public deployment verification checks that gate plus the independent
`/push/health` FCM surface. Index reads do not depend on Firebase readiness.

The former deploy script performed the one-way Compose convergence. That path
is retired; current server releases must not reactivate legacy reservation
owners or promote this stack.

## Preview-origin operator provisioning

The tracked stack exposes `preview.usebeeline.app` through the
`beeline-media-preview` alias on the existing `buzzrouter-tunnel` network, but
it deliberately does not create DNS records or certificates. Before enabling
HTML attachment cards in production, the operator must:

1. Create a proxied DNS CNAME `preview.usebeeline.app` pointing at the deployed
   Cloudflare Tunnel target (`<tunnel-id>.cfargotunnel.com`).
2. Add the tunnel public-hostname/ingress route for
   `preview.usebeeline.app` to `http://beeline-media-preview:3000` on the
   `buzzrouter-tunnel` Docker network.
3. Provision/verify an edge TLS certificate whose SAN includes
   `preview.usebeeline.app` (Cloudflare Universal SSL is sufficient when the
   record is proxied). TLS terminates at the edge; do not fabricate or mount a
   certificate in `relay-front`.
4. Verify the origin boundary after deploy: an HTML `/media/...` URL renders
   with the sandbox CSP on `https://preview.usebeeline.app`, while the same
   path on `https://usebeeline.app` returns `Content-Disposition: attachment`;
   PNG/JPEG/GIF/WebP remain inline on the product origin.
