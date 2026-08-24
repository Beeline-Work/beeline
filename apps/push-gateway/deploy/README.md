# Production deployment

> Current host state (verified 2026-08-23): the live gateway is the user systemd
> unit `buzzy-push-gateway.service`, running from
> `~/buzzy-push-gateway/current`; relay-front reaches its host-bound port 8788.
> Apply source updates by preparing and building a new immutable release,
> atomically repointing `current`, and running
> `systemctl --user restart buzzy-push-gateway.service`. Verify the public
> `/push/health` route and `journalctl --user -u buzzy-push-gateway.service`.
> Preserve `secrets/` and `state/`, and never start the Compose poller alongside
> the unit. The rollout below documents the separate container migration target,
> not the currently active host topology.

In the container migration target, the push gateway runs inside the relay
Compose project. `relay-front` reaches it as `push-gateway:8788` on the shared
network; port 8788 is never published to the host. The one process runs both
the HTTP registration server and the `RegisteredEventPoller`.

The container uses these internal paths:

- `/run/secrets/buzzy-fcm-service-account.json` — read-only Firebase service
  account.
- `/var/lib/buzzy-push/registrations.json` — durable device registry.
- `/var/lib/buzzy-push/deliveries.json` — durable delivery/cursor ledger.

Compose bind-mounts the existing host locations by default:

- `/home/lunchbox/buzzy-push-gateway/secrets/fcm-service-account.json`
- `/home/lunchbox/buzzy-push-gateway/state/`

Mounting the state directory, rather than only `registrations.json`, is
intentional: registry persistence uses an atomic temporary-file rename and the
poller must persist its delivery ledger beside the registry. Override the host
paths with `BUZZY_PUSH_SA_HOST_FILE` and `BUZZY_PUSH_STATE_DIR`. The credential
is mounted at runtime and is never copied into the image or repository.

## Relay access

The gateway reads Buzz's authoritative Postgres rows directly. Candidate queries
join each row's server-stamped community and channel to the registered recipient's
active membership. They do not resolve a community from a relay hostname, so an
alias or domain migration cannot silently point the feed at the wrong tenant.
The container receives `BUZZY_PUSH_DATABASE_URL` for the internal `postgres:5432`
service and depends on its health.

The current host systemd topology loads the same variable from
`~/buzzy-push-gateway/secrets/database.env`. The production Postgres service must
publish `127.0.0.1:5433` (the checked-in production Compose file does); keep the
database port loopback-only and the credential file mode `0600`.

For a host-systemd rollout, apply and verify the loopback Postgres mapping first,
write the database environment file, build and repoint the immutable gateway
release, then run `systemctl --user daemon-reload` and
`systemctl --user restart buzzy-push-gateway.service`. A failed database probe
fails startup instead of launching a healthy-looking starved feed. Confirm the
public health route and inspect `journalctl --user -u buzzy-push-gateway.service`
for the `postgres-tail` live/heartbeat lines and a real decision before closing.

After startup, verify both the immediate `[push] feed live mode=postgres-tail`
line after its first successful database read and a recurring
`[push] feed heartbeat ... eventsPerMinute=N` line. A
transport failure logs its retry delay; the feed issues a fresh query after
bounded exponential backoff and returns to the configured poll cadence after
the first success.

## Public routes and permanent alias

The mobile default is `https://usebeeline.app/push`; the app appends
`/registrations`. The trailing slash below strips `/push/`, so the gateway sees
its native `/registrations` route:

```nginx
location /push/ {
  proxy_pass http://push-gateway:8788/;
  proxy_http_version 1.1;
  proxy_set_header Host $http_host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_request_buffering off;
  proxy_buffering off;
}
```

`https://push.buzzrouter.com` remains a permanent alias. During this migration
it is repointed from the legacy host unit on port 8788 to relay-front's host
loopback port. `relay-stack/nginx.conf` has a hostname-specific server that
forwards the alias's unprefixed `/registrations` and `/health` paths to the same
container. Do not run the host unit and container concurrently: two pollers
sharing one state directory can duplicate sends and race durable writes.

## Container migration rollout

Run from a clean, committed checkout. The source registry must be an existing,
non-empty version-1 registry; the installer never overwrites an already
migrated registry.

1. In `/home/lunchbox/buzz-router-relay-prod/compose.yml`, add the checked-in
   `push-gateway` service from `relay-stack/compose.yml`, using that production
   file's shared relay-front network (currently `buzz-net`). Remove every
   `push-host:host-gateway` mapping from `relay-front`, and add a healthy
   `push-gateway` dependency.
2. In the deployed `relay-front/nginx.conf`, replace the `/push/` upstream with
   `http://push-gateway:8788/` and add the `push.buzzrouter.com` server from
   `relay-stack/nginx.conf`. Validate the candidate as documented in
   `relay-stack/AUTH-DEPLOY.md`.
3. Prepare/build/start the container and recreate relay-front:

   ```sh
   BUZZ_PUSH_REGISTRY_SOURCE=/absolute/path/to/registrations.recovered.json \
   BUZZ_PUSH_SA_SOURCE=/absolute/path/to/fcm-service-account.json \
   BUZZ_PROD_RELAY_DIR=/home/lunchbox/buzz-router-relay-prod \
     apps/push-gateway/deploy/install.sh
   ```

   The installer copies the secret as mode `0600`, preserves an existing state
   directory, builds `beeline-push-gateway:local`, stops/disables the legacy
   systemd unit immediately before starting the container, and recreates only
   relay-front.

4. Change the `push.buzzrouter.com` tunnel origin from host port 8788 to the
   same relay-front loopback origin used by `usebeeline.app` (port 3010 in the
   checked-in stack). This preserves the old unprefixed API through the
   hostname-specific nginx server.

## Deployment transcript and persistence proof

The registration POST must return gateway JSON. A syntactically valid
production registration returns `201`; malformed input returning the gateway's
`400` JSON is also a safe routing probe and distinguishes the gateway from a
relay 404 or proxy timeout:

```sh
curl -iS https://usebeeline.app/push/health
curl -iS -X POST https://usebeeline.app/push/registrations \
  -H 'content-type: application/json' --data '{}'
curl -iS https://push.buzzrouter.com/health
docker compose -f /home/lunchbox/buzz-router-relay-prod/compose.yml \
  ps relay push-gateway relay-front
docker compose -f /home/lunchbox/buzz-router-relay-prod/compose.yml \
  logs --tail=100 push-gateway
```

After a real device registers, record `registeredDevices`, restart only the
gateway, and confirm the count is unchanged. This exercises the bind-mounted
registry rather than merely inspecting Compose configuration:

```sh
curl -fsS https://usebeeline.app/push/health
docker compose -f /home/lunchbox/buzz-router-relay-prod/compose.yml \
  restart push-gateway
docker compose -f /home/lunchbox/buzz-router-relay-prod/compose.yml \
  up -d --wait push-gateway
curl -fsS https://usebeeline.app/push/health
```

For the end-to-end proof, use a real device (or an emulator with a real FCM
token), register through `https://usebeeline.app/push/registrations`, post a
message in a persistent Workspace-linked Room visible to that identity, and
capture both the gateway log's successful send and the displayed notification.
Append the exact HTTP, restart, event, gateway-log, and device transcript to the
deployment record before merging.

Never use the production registry with the local `buzzy-gate` project. Never
submit a fake FCM token to production. Capture-only relay behavior remains
available through:

```sh
npm run verify:live -w @beeline/push-gateway
```
