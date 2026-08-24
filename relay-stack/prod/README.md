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

## Push gateway topology

Production has one gateway. `relay-front` sends `/push/` to
`push-gateway:8788`; that container accepts registrations and tails Postgres
over the private `buzz-net` network. It bind-mounts the durable registry and
delivery state from `/home/lunchbox/buzzy-push-gateway/state/`. The retired
`buzzy-push-gateway.service` must remain disabled; see
`apps/push-gateway/deploy/README.md` for the one-time cutover checks.
