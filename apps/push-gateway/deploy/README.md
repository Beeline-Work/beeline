# Production deployment

The production gateway runs inside the relay Compose project. `relay-front`
reaches it as `push-gateway:8788` on the shared
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

Postgres stays private to the Compose network. No host database port or
`database.env` file is part of the production path.

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

`https://push.buzzrouter.com` remains a permanent alias and points at
relay-front's host loopback port. `relay-stack/nginx.conf` has a
hostname-specific server that forwards the alias's unprefixed `/registrations`
and `/health` paths to the same container. The host unit stays disabled: two
pollers sharing one state directory can duplicate sends and race durable writes.

## One-time single-gateway cutover

The deploy workflow installs `relay-stack/prod/compose.yml` and
`relay-stack/prod/nginx.conf`, builds the gateway image, and waits for Compose
health before public verification. For the one-time retirement of the legacy
host unit:

1. Let the deploy finish, then confirm the public route is backed by the
   container and the existing registry is mounted:

   ```sh
   curl -fsS https://usebeeline.app/push/health
   docker compose -p buzz-router-prod \
     --env-file /home/lunchbox/buzz-router-relay-prod/.env \
     -f /home/lunchbox/buzz-router-relay-prod/compose.yml \
     ps push-gateway relay-front
   docker logs --tail=100 buzz-router-prod-push-gateway-1
   ```

2. Compare `registeredDevices` with the pre-cutover count. Only after it
   matches, retire the duplicate host process:

   ```sh
   systemctl --user disable --now buzzy-push-gateway.service
   systemctl --user is-active buzzy-push-gateway.service  # must print inactive
   ```

3. Verify registration and delivery again, then remove any obsolete host-only
   firewall allowances for ports 8788 and 5433. Keep
   `/home/lunchbox/buzzy-push-gateway/state/` and `secrets/`; Compose owns them.

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
token), register through `https://usebeeline.app/push/registrations`, then post
an explicit mention, DM, or agent waiting-on-human transition in a persistent
Workspace-linked Room visible to that identity. Capture both the gateway log's
successful send and the displayed notification. Also post ordinary chat and
confirm its decision trace says `fatigue-policy-ambient` with no FCM send.
Append the exact HTTP, restart, events, gateway logs, and device transcript to
the deployment record before merging.

Never use the production registry with the local `buzzy-gate` project. Never
submit a fake FCM token to production. Capture-only relay behavior remains
available through:

```sh
npm run verify:live -w @beeline/push-gateway
```
