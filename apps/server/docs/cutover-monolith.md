# Monolith after cutover

The one-time legacy workspace migration is complete. Execute and rehearse modes
are retired; the cutover script retains only guarded rollback for recorded state.
Historical evidence remains in the dated rehearsal documents.

## Authentication configuration

The deployed monolith must leave `PHONE_GITHUB_EXCHANGE_ENDPOINT` unset. It mounts the existing `@beeline/auth` routes and consumes the one-use GitHub ticket directly from its own PostgreSQL-backed auth store. The variable remains only as an explicit remote-verifier override for tests and migrations.

Set `PUBLIC_ORIGIN=https://server.usebeeline.app` and include this exact tenant in `BUZZY_AUTH_TENANTS_JSON`: `{"host":"server.usebeeline.app","community":"<stable identity namespace>","roomCommunityIds":["<server-stamped relay community UUID>"],"origin":"https://server.usebeeline.app"}`. Set the six `BUZZY_AUTH_OIDC_*` values used by `@beeline/auth`, plus `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`. On the GitHub App dashboard, keep the OAuth callback URL at `https://server.usebeeline.app/auth/github/callback`, set the installation setup URL to `https://server.usebeeline.app/v1/github/install/callback`, set the webhook URL to `https://server.usebeeline.app/v1/github/webhook`, and keep user authorization during installation enabled. Also enable Expiring user authorization tokens as required by [the auth service's GitHub App guidance](../../auth/README.md#github-user-token-rotation). The `/auth/github/install/callback` and `/auth/github/webhook` paths belong to the retired relay-era store and must not receive new App deliveries after the monolith cut. These dashboard changes are operator actions outside this repository.

## Unified releases after cutover

`.github/workflows/unified-release.yml` keeps the existing server artifact build in
the release-wide build gate. After all three artifacts match one release SHA, the
server promotion checks the self-hosted runner's Fly authentication and runs:

```bash
flyctl deploy . \
  --config fly.beeline-server.toml \
  --dockerfile apps/server/Dockerfile \
  --app beeline-server \
  --build-arg "BEELINE_RELEASE_VERSION=$RELEASE_VERSION" \
  --build-arg "BEELINE_RELEASE_SHA=$RELEASE_SHA" \
  --yes
```

The job checks out `RELEASE_SHA` before invoking Fly. Promotion is confirmed only
after `GET https://server.usebeeline.app/readyz` returns a healthy response and
`GET https://server.usebeeline.app/version` reports the same release version and
full source SHA baked into the image. Only then may the unchanged daemon bundle
publish and mobile OTA promotion begin. The production runner already owns Fly
credentials; if that changes, provision `FLY_API_TOKEN` as a repository Actions
secret instead of putting credentials in the workflow.

The Fly app must also have `PUSH_DELIVERY_ENABLED=true` and the complete Firebase
service-account document in the `GOOGLE_APPLICATION_CREDENTIALS_JSON` secret.
`GOOGLE_CLOUD_PROJECT` may override the service account's project ID when needed.
Do not add any of these secret values to the repository; release provisioning owns
the Fly secret configuration.

## Rollback boundary

Before `reopen`, rollback may re-point daemon runtime records and the phone OTA to the old stack:

```bash
scripts/cutover-monolith.sh --rollback --target-origin https://server.usebeeline.app
```

Set `CUTOVER_ROLLBACK_DAEMONS_COMMAND`, `CUTOVER_ROLLBACK_OTA_COMMAND`, and `CUTOVER_ROLLBACK_VERIFY_COMMAND` first. The daemon rollback command removes the staged `transport` object; it never invents or reuses a consumed exchange token.

**After writes reopen, rollback is forward-only. Never point a writer at the old snapshot. Doing so creates two histories and loses acknowledged user work. Fix or redeploy the monolith instead.**
