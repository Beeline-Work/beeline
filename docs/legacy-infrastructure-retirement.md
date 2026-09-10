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
  install continuity. OS app-link declarations for the retired relay hostname
  remain so already-issued invite links can enter installed apps; they are not
  API transports. `relay-stack`, `apps/gate`, and relay helpers remain for
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

## Final cutover verification (2026-09-09)

The repository variable was already at the final value before the retirement
check and was written idempotently to the same value:

- `BEELINE_PAGES_MANIFEST_URL=https://usebeeline.app/dl/manifest.json`
- `BEELINE_DL_LEGACY_MIRROR` is absent. Current release wiring has no input,
  environment variable, or step that can publish the old mirror.

Pages run `34391717505` deployed commit `ff4672f6` after the mirror publisher
was removed. Its installer proof fetched version `v0.0.67`, source commit
`27dfa1c8f3015b1fdf032a7c9ddf009de716c934`, and bundle digest
`72d6399dc0ce7fedb7991407fd14ff84a48f8023fd01a75200ae710d68d5fe2d`
from `https://usebeeline.app/dl/manifest.json`. A separate live read compared
that manifest byte-for-byte with the `helper-update-channel` release asset,
downloaded the public tarball, verified the same digest, and compared both
app-association responses with their repository copies. The Fly `/version`
response named the same version and source commit; no Fly service was changed.

The reversible host-side retirement state is:

- `buzz-agent.service` is disabled and inactive. Its `ExecStart` tree no
  longer exists; its last process was `buzz-acp`, which only retried the dead
  `wss://buzz.trustysquire.ai` endpoint before shutting down cleanly.
- `buzzy-push-gateway.service` is not loaded; its preserved unit is the
  quarantined file named above.
- `buzz-router-prod-relay-front-1` is stopped (`Exited (0)`) with its container,
  bind-mounted web data, Compose file, and volumes retained.

No Cloudflare connector or DNS/tunnel route was retired in this pass. The live
`buzzrouter-web-1` and `buzzrouter-worker-1` containers both set
`BUZZROUTER_HOME_RELAY_URL=wss://relay.buzzrouter.com`, and the BuzzRouter
source defaults to that URL. Its `buzzrouter-tunnel-1` connector also serves
the separate BuzzRouter product. The public relay currently answers HTTP 502
while the retained relay-front is stopped. That is an exact unresolved
consumer, so the shared tunnel, `relay.buzzrouter.com` route, BuzzRouter
containers, and stopped relay-front object must not be deleted as part of
Beeline retirement. `push.buzzrouter.com` returns 530 and
`buzz.trustysquire.ai` returns 521; neither response is proof that a shared
tunnel can be removed.

## Rollback

No running shared service was changed by the final verification. To undo the
only external mutation, restore `BEELINE_PAGES_MANIFEST_URL` to its recorded
pre-check value, which is the same `https://usebeeline.app/dl/manifest.json`.
The absent legacy-mirror variable does not need restoration because current
release code cannot read it.

If a separately authorized BuzzRouter recovery needs the stopped front for
investigation, `docker start buzz-router-prod-relay-front-1` restores that exact
container without recreating it or touching the shared tunnel. This alone does
not restore the retired relay/auth/push backends: their container names are
currently occupied by inert placeholders. Restoring those backends requires a
separate BuzzRouter-owned decision. Do not restart the whole Compose project,
do not stop `buzzrouter-tunnel-1`, and do not change
`server.usebeeline.app`.
