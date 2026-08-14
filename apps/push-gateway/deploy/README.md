# Production deployment

Production separates event wakeups from message reads:

- `https://relay.buzzrouter.com` remains the public, auth-enforced WebSocket origin.
- `http://127.0.0.1:3410` is a host-loopback-only `POST /query` origin.
- The trusted relay replica binds its TCP app listener to container loopback and
  exposes a Unix socket only to the query-only Nginx sidecar. Both run as the
  socket-owner UID/GID, so no world-writable socket is needed. The normal relay
  container and public relay-front configuration are not changed.
- `POST /query` still runs the relay's normal per-reader channel ACL filtering.
  `X-Pubkey` selects one registered recipient's view; it is not a blanket read.

The extra relay process is a normal horizontally-scaled replica sharing the
production Postgres and Redis services. Its huddle-audio path is disabled, and
its trusted HTTP surface cannot publish events or reach the public tunnel.

## Install or update

Run from a clean, committed checkout. The registry source must be an existing,
non-empty version-1 registry; the installer never replaces an already-migrated
durable registry.

```sh
BUZZ_PUSH_REGISTRY_SOURCE=/absolute/path/to/registrations.recovered.json \
BUZZ_PUSH_SA_SOURCE=/absolute/path/to/fcm-service-account.json \
  apps/push-gateway/deploy/install.sh
```

The installer creates `/home/lunchbox/buzzy-push-gateway/`, builds an immutable
release, installs the recovered registry and Firebase credential mode `0600`,
starts the trusted read sidecars, and enables the user service. User lingering
must be enabled so the service starts on boot.

## Safe verification

```sh
curl -fsS http://127.0.0.1:3410/health
curl -fsS http://127.0.0.1:8788/health
curl -fsS https://push.buzzrouter.com/health
systemctl --user status buzzy-push-gateway.service
```

Never use the production registry with `127.0.0.1:3010` or the `buzzy-gate`
compose project. End-to-end notification tests must use a separate throwaway
registry and a capturing `Messaging` implementation; do not submit a fake FCM
token to the production service.

On-device and live-relay tests must create a fresh test identity and a separate
Workspace containing only generated test identities. The captain's identity
must not be a Workspace/Room member, and the captain's device token must never
be registered or copied into the test registry. Emulator/test clients must send
`environment: "emulator"` or `environment: "test"`; the registration endpoint
acknowledges those tokens without storing them. A test harness that cannot prove
these constraints must use capture-only messaging and stop before registration.

The checked-in proof creates an isolated Workspace whose exact member set is two
fresh identities, plus a persistent real Room and a
`research-no-findings-*` fixture Room. It posts one event to each, proves the
recipient can privately read the real event while an outsider cannot and the
public `/query` remains auth-enforced, then captures payloads without any FCM
network client. The fixture produces zero captures and the real Room exactly
one. Duplicate polling, durable-state reload, and direct replay add zero sends:

```sh
npm run verify:live -w @beeline/push-gateway
```
