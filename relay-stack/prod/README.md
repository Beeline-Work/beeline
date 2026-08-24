# Production relay stack (tracked)

This directory is the **production** stack config, deployed by
`scripts/deploy-relay-host.sh` on every merge to `main`. It is NOT the same
stack as `relay-stack/compose.yml` + `relay-stack/nginx.conf` one level up:

| | `relay-stack/` (gate) | `relay-stack/prod/` (this dir) |
| --- | --- | --- |
| compose project | `buzzy-gate` | `buzz-router-prod` |
| purpose | isolated Phase-0 merge-gate proof | the live relay behind usebeeline.app |
| deploy path | `npm run stack:up` (manual/local) | CI via `scripts/deploy-relay-host.sh` |

Keep them separate on purpose: the gate stack serves the merge-gate proof and
must stay untouched by production deploys; this directory reproduces the
production host's `/home/lunchbox/buzz-router-relay-prod/{compose.yml,
relay-front/nginx.conf}` so infra changes actually reach production through
the pipeline instead of being hand-applied (or silently landing nowhere).

## Secrets

Never committed: env files (`$PROJECT_DIR/.env`,
`/home/lunchbox/buzzy-auth/oidc.env`, `beeline-github.env`) and the push
gateway's FCM service-account key live only on the host. This directory holds
paths and defaults only.

## Privileged steps

The runner user cannot read/write the lunchbox-owned host config files, so the
deploy goes through fixed-argument passwordless sudo rules. The exact lines
required are documented in the header of `scripts/deploy-relay-host.sh`; if a
rule is missing the deploy fails loudly at that step rather than working
around it.

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
