# Production OIDC auth sidecar

The `auth` Compose service runs `@beeline/auth` on the relay's private Docker
network and stores its namespaced tables in the relay's durable PostgreSQL
volume. Only `/auth/` is routed to it; relay HTTP and WebSocket traffic keeps
the existing catch-all route.

## Google OAuth client

Create a Google Web application OAuth client with:

- Authorized redirect URI: `https://usebeeline.app/auth/oidc/callback`
- Legacy redirect URI: `https://relay.buzzrouter.com/auth/oidc/callback` (keep registered)
- Authorized JavaScript origins: none
- Requested scope: `openid`

The native app completion is the associated HTTPS link
`https://usebeeline.app/auth/oidc/mobile-callback`. The shipped
`https://relay.buzzrouter.com/auth/oidc/mobile-callback` remains associated as
an alias. These are app redirects, not Google OAuth redirect URIs.

The GitHub OAuth callback is `https://usebeeline.app/auth/github/callback`.
Keep `https://relay.buzzrouter.com/auth/github/callback` registered for clients
whose stored relay URL still uses the permanent alias.

## Secret file

Create the persistent host directory outside the checkout, and write a
root/operator-readable file at `/home/lunchbox/buzzy-auth/oidc.env`:

```dotenv
BUZZY_AUTH_OIDC_CLIENT_ID=<google-web-client-id>
BUZZY_AUTH_OIDC_CLIENT_SECRET=<google-web-client-secret>
```

Set mode `0600`. Never copy this file into the repository or an image. Override
its path with `BUZZY_AUTH_ENV_FILE` when necessary.

## Deploy safely

From `relay-stack/`, build and start only the new sidecar:

```sh
docker compose --env-file .env build auth
docker compose --env-file .env up -d --no-deps auth
docker compose --env-file .env ps auth
```

Copy the `/auth/` location from `nginx.conf` into the live relay-front config
and back that file up first. The production relay-front mounts `nginx.conf` as
a read-only single-file bind. Atomic host-side edits replace the source inode,
while the running container remains pinned to the old inode, so `nginx -s
reload` alone does not see the change.

Validate the candidate config on `buzz-net`, then restart **only** relay-front
to attach the new inode. Never restart or recreate the relay:

```sh
docker run --rm --network buzz-router-prod_buzz-net \
  -v /home/lunchbox/buzz-router-relay-prod/relay-front/nginx.conf:/etc/nginx/nginx.conf:ro \
  nginx:1.27-alpine nginx -t
docker restart buzz-router-prod-relay-front-1
docker exec buzz-router-prod-relay-front-1 nginx -t
```

Verify `/auth/oidc/start` returns `302` to Google with `client_id`, `scope`, and
`redirect_uri` set correctly. Re-run the relay's signed `/query` and WebSocket
probes after the relay-front restart.
