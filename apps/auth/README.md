# `@beeline/auth`

This is Beeline's narrow OAuth/OIDC-to-Nostr-public-key binding library. GitHub and Google are the supported sign-in providers. Google remains behind
a server rollout flag and subject allowlist until device acceptance is complete. It owns the Authorization Code + PKCE ceremony and a durable one-use binding
transaction. It does not issue transport credentials, grant roles or membership,
or accept a Nostr secret key.

## Protocol

1. `GET /auth/oidc/start` resolves the tenant from the request `Host`, stores a
   hashed one-use OAuth state bound to an HttpOnly browser-session cookie, with
   a nonce and PKCE verifier, and redirects to the configured provider. Native
   clients bind the tenant's verified HTTPS app link and random `app_state` to
   the flow; OAuth codes and tokens never enter that app redirect. Custom
   schemes are allowlisted only by the loopback device-emulator fixture.
2. `GET /auth/oidc/callback` atomically consumes the flow, exchanges the code
   server-side, validates the pinned issuer/audience/RS256 token and nonce, and
   returns one short-lived bind ticket and the exact fields the device key must
   sign. The database stores only the SHA-256 ticket hash.
3. `POST /auth/oidc/bind` accepts `{ "ticket": "...", "event": { ... } }`.
   The signed kind `24250` event must contain exactly one each of `t`,
   `protocol`, `ticket`, `challenge`, `provider`, `audience`, `subject`,
   `community`, `issued_at`, and `expires_at`, all matching the ticket, and be
   inside its timestamp window. Ticket consumption and the
   create-only identity link happen in one PostgreSQL transaction. Five invalid
   signed-event attempts durably burn the ticket.
4. A conflicting normal bind remains a `409 identity_conflict`; it never moves
   the link. `POST /auth/oidc/recover` is the separate recovery ceremony. It
   accepts only the same still-live OAuth ticket and signed candidate-key event
   that already reached the conflict path, plus `confirm_replace: true`, then
   atomically moves the identity link. This deliberately means an attacker who
   controls the GitHub account can replace its Beeline device-key link after an
   explicit recovery action, which a normal sign-in could not previously do.
   That tradeoff is necessary for self-service loss recovery. It does not reveal
   or transfer the old Nostr secret, Rooms, DMs, profile, memberships, roles, or
   GitHub App repository grants; those remain attached to the old key.
5. `GET /auth/oidc/links/:pubkey` requires a fresh, exact-URL/method NIP-98
   header signed by that public key. Auth-event IDs are durably replay guarded.
   The response is tenant-scoped and never contains email.

Repository onboarding is always available to every user, without feature flags, a GitHub subject or an eligibility cookie. Signed cookies still bind installation callbacks to the account that started them.

## Managed display handles

The mounted auth library preserves identity labels without publishing a public name resolver:

- A verified GitHub bind stores the current GitHub login as the handle and
  returns the GitHub display name to the client. There is no naming step in the
  GitHub onboarding path.
- `GET /auth/identity/:pubkey` returns the key's canonical managed identity.
  When a key-only user links GitHub later, the link stays on that same key and
  the response offers one optional `POST /auth/identity/:pubkey/github-handle`
  rename. Keeping the original handle remains valid.

Custom NIP-05 identifiers remain ordinary optional profile data. They are not
part of managed display handles and are never an authentication prerequisite.

There is deliberately no endpoint that accepts a bearer ID token and no OIDC
token that can authorize `/events`, `/query`, WebSockets, or Room state.

## Deployment shape

The Beeline server mounts this library through `apps/server/src/monolith-auth.ts`
and uses its PostgreSQL database. There is no standalone listener or container.

GitHub follows the same bind-ticket transaction through `/auth/github/start`
and `/auth/github/callback`. After binding, `/auth/github/install/start` opens
a Beeline GitHub App installation for a personal account or organization.
`/auth/github/repos/:pubkey` normally reads the webhook-maintained repository
snapshot for every installation linked to that identity. A deliberate
`?refresh=1` after the GitHub browser returns re-reads each active installation
so webhook timing cannot strand the picker. Installation callbacks verify
membership with the encrypted GitHub user token captured during sign-in. The app's exact required
permissions and events live in one place — `REQUIRED_GITHUB_APP_PERMISSIONS` and
`REQUIRED_GITHUB_APP_EVENTS` in `apps/auth/src/github-manifest.ts` (contents write, pull_requests
write, issues write, actions write, secrets write, environments write, workflows write, discussions write, checks read, statuses read,
metadata read; events `star`, `issues`, `pull_request`, `push`, `check_run`, `check_suite`,
`status`). Administration and
organization permissions are intentionally excluded. Secrets and environments are requested for new
Apps but are optional for existing Apps; their absence does not cause configuration drift or block existing features. The auth
library mints exact-repository, one-hour installation tokens for Room-member
daemons after re-checking current signed membership and the Room's admin-authored
repository binding. Daemons never receive the App private key. Body installs a
corner-local Git credential helper and `gh` wrapper that refresh this scoped
token for every invocation; ambient host credentials remain masked.

GitHub is configured by the monolith when `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and
`GITHUB_APP_PRIVATE_KEY` are present. `GITHUB_WEBHOOK_SECRET` authenticates
webhook deliveries.
`GET /auth/capabilities` then reports `github: true`; without them it reports
`github: false`, GitHub routes stay unavailable, and auth capabilities remain disabled for GitHub.

The `BEELINE_AUTH_OIDC_*` settings take precedence over their legacy
`BUZZY_AUTH_OIDC_*` equivalents. Legacy names remain a temporary fallback until
the new names are deployed and Google sign-in is verified; remove the old Fly
values and fallback only after that verification.

`BEELINE_AUTH_ALLOW_INSECURE_OIDC` likewise falls back to
`BUZZY_AUTH_ALLOW_INSECURE_OIDC` and is always ignored in production.

Required configuration:

- `DATABASE_URL`
- `BEELINE_AUTH_TENANTS_JSON`, for example
  `[{"host":"auth.example","community":"stable-identity-namespace","roomCommunityIds":["community-uuid-a","community-uuid-b"],"origin":"https://auth.example"}]`.
  `community` namespaces durable identity links and may intentionally remain the old host across
  aliases. `roomCommunityIds` is the non-empty allowlist of server-stamped tenant UUIDs from
  `channels.community_id` whose Rooms this auth tenant serves. Do not use the client-authored
  `community` tag from a Room create event for this list.
- `BEELINE_AUTH_OIDC_ISSUER`
- `BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT`
- `BEELINE_AUTH_OIDC_TOKEN_ENDPOINT`
- `BEELINE_AUTH_OIDC_JWKS_URI`
- `BEELINE_AUTH_OIDC_CLIENT_ID`
- `BEELINE_AUTH_OIDC_CLIENT_SECRET` (mandatory when `NODE_ENV=production`)
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY` (PEM; `\\n`-escaped environment values are accepted)
- `GITHUB_WEBHOOK_SECRET`
- `BEELINE_AUTH_SETUP_TOKEN` (optional) — shared secret that gates the GitHub App
  manifest setup page (`/auth/github/app-setup`) and the on-demand drift
  endpoint (`/auth/github/app-drift`). When unset both surfaces refuse; they
  are operator-only, never public.

### Creating the GitHub App: use the manifest setup page

THE way to create the Beeline GitHub App is the manifest flow — do not
hand-assemble checkboxes on github.com. A hand-created app once shipped with
`"events": []`: webhook URL and secret were right, but GitHub delivered
nothing and the repository-activity feed was silently dead.

1. Set `BEELINE_AUTH_SETUP_TOKEN` on the Beeline server and open
   `https://<tenant>/auth/github/app-setup?token=<BEELINE_AUTH_SETUP_TOKEN>`.
2. Submit the form. It POSTs a prebuilt manifest to GitHub's
   `github.com/settings/apps/new` with everything preconfigured: the webhook
   URL (`https://<tenant>/auth/github/webhook`), the events the product
   consumes (`star`, `issues`, `pull_request`, `push`, `check_run`, `check_suite`, `status`), and exactly the permission set
   the code paths need (`apps/auth/src/github-manifest.ts` documents each one).
   GitHub generates the webhook secret during creation.
3. GitHub redirects back to the same page with a one-time code; the service
   exchanges it via `POST /app-manifests/{code}/conversions` and renders a
   copy-paste `GITHUB_*` environment block. The block is shown once
   and never logged — stage it in the Beeline server environment for the next release.
4. Install the App on your account or organization from the link on the page.

The startup drift check compares the live App (`GET /app`) against the same
required events + existing-feature permissions every time the service boots and logs one plain,
actionable line naming anything missing plus the fix URL
(`https://github.com/settings/apps/<slug>/permissions`); the same check runs
on demand at `/auth/github/app-drift?token=<BEELINE_AUTH_SETUP_TOKEN>`. The
check is best-effort — an unreachable api.github.com logs one line and never
crashes the service.

### Updating an existing App for repository secrets and environments

The manifest change only affects newly created Apps. The owner must update the existing
Beeline-Work App on github.com; deploying this code does not change its registration.

1. Open the App owner's **Settings → Developer settings → GitHub Apps** (for an
   organization-owned App, start at that organization's Settings), then **Edit**
   beside the Beeline App.
2. Open **Permissions & events → Repository permissions**. Set **Secrets** and
   **Environments** to **Read and write**, then **Save changes**. Leave other grants unchanged.
3. As an owner of Beeline-Work, open GitHub's permission-update notification email
   and follow **Review permission request** for that installation. Review and accept
   the two added permissions. The installation can also be reached from
   **Beeline-Work → Settings → GitHub Apps → Configure** beside the Beeline App.
4. Retry the repository secrets request with a newly minted installation token:
   `gh api repos/Beeline-Work/beeline/actions/secrets`. It should return HTTP 200.
   Do not put secret values in logs or chat.

GitHub retains the installation's previous permissions until its owner approves the update.
Existing Beeline features continue to work without the new grants. See GitHub's
[registration update guide](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)
and [permission approval guide](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app).

### GitHub user-token rotation

The GitHub App requests user authorization during installation, so its User
authorization callback is `https://<tenant>/auth/github/callback` and GitHub's
Setup URL field is intentionally unavailable. Keep **Redirect on update**
enabled: the same callback dispatches `installation_id`/`setup_action` returns
from installs and repository-selection updates before deep-linking to Beeline.
An organization that requires approval returns `setup_action=request` with no
`installation_id` while the install is still pending; that is an unfinished
installation, never a dead link — the callback says so, spends nothing, and
lets GitHub's later approval callback complete the same state. Reconciliation
(every five minutes) picks up an approved install even if that callback never
lands.
Enable the GitHub App dashboard's **Expiring user authorization tokens** setting.
It is a GitHub App setting, not an OAuth scope: when GitHub returns a refresh
token and expiry, Beeline seals them in server-side credential storage and uses
the refresh grant to rotate an expiring user token. Without a usable refresh
grant, an expired or rejected credential requires the person to reconnect
GitHub; temporary GitHub API failures do not make that determination. This
repository cannot verify the production App setting.
The webhook URL is `https://<tenant>/auth/github/webhook` with the `installation`
and `installation_repositories` events enabled. The older
`/auth/github/installed` and `/auth/github/install/callback` routes remain only
as compatibility aliases. Body daemons obtain short-lived tokens from this
service for clone, fetch, push, pull-request operations, repository settings,
rename, preview, and CI reads; the App private key stays here.

Monolith production uses `https://server.usebeeline.app/auth/github/callback`.
`usebeeline.app` is the static Pages origin, not an auth tenant. Retired service
domains must not be restored to production tenant configuration.

HTTP OIDC endpoints are accepted only for local emulators when
`BEELINE_AUTH_ALLOW_INSECURE_OIDC=true` and `NODE_ENV` is not `production`.

## Local device emulator

`npm run dev:emulator -w @beeline/auth` runs the same auto-approving OIDC shape
used by the hermetic suite plus an in-memory auth service. It listens on
`127.0.0.1:8790` (provider) and `127.0.0.1:8789` (auth). For Android, reverse
both ports with `adb reverse` for browser-based auth fixture tests.
This mode deliberately
uses a non-`__Host-` browser cookie because the loopback fixture is HTTP; the
production default remains `Secure` and `__Host-` prefixed.

## Google sign-in

Google sign-in is on for every user. `/auth/capabilities` always reports
`google: true`, and any verified Google account may sign in.

The browser requests `openid email profile`; only verified email supplies the
initial handle. The OAuth client, nonce, PKCE, issuer, audience and one-use
ticket remain server verified. `/auth/oidc/completion` recovers dropped
redirects through the state-bound recovery secret on native, web and desktop.
Profiles are initialized once and are preserved on subsequent sign-ins.
Accounts are never linked by email.

Environment naming: `BEELINE_AUTH_TENANTS_JSON`, `BEELINE_AUTH_SETUP_TOKEN`, and
`BEELINE_AUTH_HOST` prefer the Beeline spelling; the matching `BUZZY_` names still work.
When both spellings are set, `BEELINE_` wins, including an empty value.

See [environment naming and compatibility](../../docs/environment-names.md) for the full migration and production staging rules.
