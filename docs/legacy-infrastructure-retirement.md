# Legacy Buzz/Nostr retirement

Production is the Fly app `beeline-server` at
`https://server.usebeeline.app`, deployed from `Beeline-Work/beeline`. The
phone has no runtime switch back to a relay transport. The release workflow
builds and deploys only the monolith server image and no longer publishes to a
host-side relay-front directory.

## Inventory

- **Live dependency:** `apps/server` and the mobile monolith transport use the
  Fly server. `@beeline/nostr` and parts of `@beeline/buzz-client` remain
  load-bearing libraries for signing/event DTOs and indexed Room views; their
  package names are not evidence of Nostr production routing.
- **Deliberate compatibility:** `app.buzzy.mobile` identifiers remain for
  install continuity. `relay-stack`, `apps/gate`, and relay helpers remain for
  the isolated loopback development/proof stack and historical data reads;
  their shared defaults are loopback-only.
- **Retired:** `buzz.trustysquire.ai`, `relay.buzzrouter.com`,
  `push.buzzrouter.com`, the separate auth/materializer images, relay-front
  bundle mirroring, and the old host `buzz-agent` are not production paths.
  Cutover scripts and migrations are historical records, not runnable current
  topology.

`scripts/legacy-production-routing.test.mjs` is the regression proof covering
mobile defaults, release/deploy wiring, the server image build, capabilities,
and the Fly manifest.

## External objects

The 2026-09-09 host audit found the following retirement candidates. Preserve
their data until the captain separately authorizes deletion:

- `buzz-agent.service`: stopped and disabled after proving its sole process was
  the deleted legacy `buzz-acp` binary reconnecting only to
  `wss://buzz.trustysquire.ai` (HTTP 521), with no service dependents.
- Docker container `buzz-router-prod-relay-front-1`: the legacy static/relay
  front for `relay.buzzrouter.com`; stopping it is reversible and does not
  remove its bind-mounted data.
- Disabled user unit `buzzy-push-gateway.service`, directory
  `/home/lunchbox/buzz-router-relay-prod`, and sudoers rules
  `/etc/sudoers.d/beeline-deploy-compose` and
  `/etc/sudoers.d/beeline-deploy-cutover`: the unit was quarantined at
  `~/.config/systemd/user/retired-beeline/buzzy-push-gateway.service.retired-20260909`.
  Retain the directory and rules until this PR lands. The captain can then
  reversibly quarantine the rules with:

  ```sh
  sudo install -d -m 0700 /root/beeline-retired-sudoers
  sudo mv /etc/sudoers.d/beeline-deploy-compose /root/beeline-retired-sudoers/
  sudo mv /etc/sudoers.d/beeline-deploy-cutover /root/beeline-retired-sudoers/
  sudo visudo -cf /etc/sudoers
  ```
- DNS/tunnel routes for the three retired hostnames above: external resources;
  remove only after confirming the stopped endpoints remain unconsumed.

Do not stop `cloudflared.service` or the `buzzrouter` compose project: the host
audit proved they serve unrelated, current VNC and Buzzrouter product routes.
