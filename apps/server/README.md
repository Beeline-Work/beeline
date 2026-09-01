# @beeline/server

Beeline's production monolith is one framework-free TypeScript process backed by one PostgreSQL database. It serves the token-authenticated phone and daemon contracts, mounts the GitHub identity routes, and owns monolith GitHub App callbacks and webhooks.

## Surfaces

- `/v1/auth/github/exchange`, `/v1/auth/refresh`: opaque phone access and rotating refresh tokens.
- `/v1/auth/daemon/exchange`: one-use exchange into an opaque daemon token.
- `/v1/phone/*`: the complete indexed phone read surface, named writes from `@beeline/api-contract/phone`, read marks, media, GitHub room tokens, push registration, and OTA receipts.
- `/v1/phone/live`: authenticated WebSocket invalidation plus draft, thought, and presence overlays.
- `/v1/daemon/operations/:name`: only names in `DaemonOperationMap`. There is no event filter, event query, or generic publish endpoint.
- `/v1/github/install/callback`: one-use GitHub App installation completion.
- `/v1/github/webhook`: signature-checked, delivery-ID-deduplicated GitHub events.
- `/healthz`: process health.

All state shared by the two configured Fly Machines is in PostgreSQL. Each process has a five-connection maximum. One dedicated PostgreSQL advisory-lock connection elects the sole push/maintenance owner; its peer takes ownership when the connection dies.

## Local development

```sh
createdb beeline_server_local
DATABASE_URL='postgresql://USER@localhost/beeline_server_local?host=%2Fvar%2Frun%2Fpostgresql' \
  NODE_ENV=development npm run dev -w @beeline/server
```

`local:<github-login>` is accepted as the exchange token only outside production. Production mounts `@beeline/auth` on the same listener and consumes GitHub tickets in-process. `PHONE_GITHUB_EXCHANGE_ENDPOINT` is an override for tests and migrations, not a production requirement.

GitHub account/install/repository operations are enabled when `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_SLUG` are all present. `GITHUB_WEBHOOK_SECRET` enables signed webhook intake. Push sending is opt-in with `PUSH_DELIVERY_ENABLED=true` and Application Default Credentials; without it, devices remain registered but no delivery claims are created.

The mounted auth routes also require `PUBLIC_ORIGIN`, `BUZZY_AUTH_TENANTS_JSON`, and the six `BUZZY_AUTH_OIDC_*` values documented in `apps/auth/README.md`. The tenants JSON must contain an entry whose host and origin match `PUBLIC_ORIGIN`; production uses `server.usebeeline.app`.

```sh
npm run typecheck -w @beeline/server
npm test -w @beeline/server
```

## Import

The importer reads a transaction-consistent old PostgreSQL snapshot directly from `channels`, `channel_members`, `users`, `events`, server-owned read marks, and the auth/GitHub tables. It applies the existing push-gateway `projectEvent` rules. It never discovers data through RoomView HTTP and never selects the relay audit table.

```sh
OLD_DATABASE_URL=postgresql://... \
DATABASE_URL=postgresql://... \
OLD_PUSH_REGISTRY_JSON=/snapshot/registrations.json \
OLD_MEDIA_MANIFEST_JSON=/snapshot/media.json \
npm run import -w @beeline/server
```

`import_runs` and `import_items` make the command restartable with the same `IMPORT_ID`. Media is imported before messages so legacy attachment URLs are rewritten to PostgreSQL-backed `/v1/media/:id` URLs. The command exits `2` if the measured new database reaches the 500,000,000-byte Neon ceiling.

See [credential-ceremony.md](docs/credential-ceremony.md), [import-format.md](docs/import-format.md), and [neon-fit.md](docs/neon-fit.md). `fly.toml` is configuration only; provisioning and deployment are Phase C owner actions.
