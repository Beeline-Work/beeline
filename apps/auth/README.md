# `@beeline/auth`

This is Beeline's narrow OAuth/OIDC-to-Nostr-public-key binding service. GitHub
is the shipped sign-in; the Google OIDC routes remain available but are hidden
from the app. It owns the Authorization Code + PKCE ceremony and a durable one-use binding
transaction. It does not issue relay credentials, grant roles or membership,
participate in merge decisions, or accept a Nostr secret key.

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
   GitHub App repository approvals; those remain attached to the old key.
5. `GET /auth/oidc/links/:pubkey` requires a fresh, exact-URL/method NIP-98
   header signed by that public key. Auth-event IDs are durably replay guarded.
   The response is tenant-scoped and never contains email.

There is deliberately no endpoint that accepts a bearer ID token and no OIDC
token that can authorize `/events`, `/query`, WebSockets, Room state, or the
merge gate.

## Deployment shape

Run this as a small sidecar on the existing Beeline network with the existing
PostgreSQL service, then route `/auth/` to it from `relay-front` while
preserving the original `Host`. All other relay traffic remains on Buzz. Adding
that production route and deploying the service are intentionally deferred.

GitHub follows the same bind-ticket transaction through `/auth/github/start`
and `/auth/github/callback`. After binding, `/auth/github/install/start` opens
a Beeline GitHub App installation for a personal account or organization.
`/auth/github/repos/:pubkey` normally reads the webhook-maintained repository
snapshot for every installation linked to that identity. A deliberate
`?refresh=1` after the GitHub browser returns re-reads each active installation
so webhook timing cannot strand the picker. Installation callbacks verify
membership with the encrypted GitHub user token captured during sign-in. The app needs Contents
read/write, Metadata read, and Administration write permissions. The auth
sidecar mints exact-repository, one-hour installation tokens for Room-member
daemons after re-checking current relay membership and the Room's admin-authored
repository binding. Daemons never receive the App private key and do not
consult `gh`, credential helpers, or ambient Git configuration.

GitHub ships dark until **all six** `BEELINE_GITHUB_*` values below are present.
`GET /auth/capabilities` then reports `github: true`; without them it reports
`github: false`, GitHub routes stay unavailable, and the existing Google OIDC
sign-in remains the visible, unchanged mobile path.

Required configuration:

- `DATABASE_URL`
- `BUZZY_AUTH_TENANTS_JSON`, for example
  `[{"host":"relay.example","community":"stable-identity-namespace","roomCommunityIds":["relay-community-uuid-a","relay-community-uuid-b"],"origin":"https://relay.example"}]`.
  `community` namespaces durable identity links and may intentionally remain the old host across
  aliases. `roomCommunityIds` is the non-empty allowlist of server-stamped relay tenant UUIDs from
  `channels.community_id` whose Rooms this auth tenant serves. Do not use the client-authored
  `community` tag from a Room create event for this list.
- `BUZZY_AUTH_OIDC_ISSUER`
- `BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT`
- `BUZZY_AUTH_OIDC_TOKEN_ENDPOINT`
- `BUZZY_AUTH_OIDC_JWKS_URI`
- `BUZZY_AUTH_OIDC_CLIENT_ID`
- `BUZZY_AUTH_OIDC_CLIENT_SECRET` (mandatory when `NODE_ENV=production`)
- `BEELINE_GITHUB_CLIENT_ID`
- `BEELINE_GITHUB_CLIENT_SECRET`
- `BEELINE_GITHUB_APP_ID`
- `BEELINE_GITHUB_APP_SLUG`
- `BEELINE_GITHUB_APP_PRIVATE_KEY` (PEM; `\\n`-escaped environment values are accepted)
- `BEELINE_GITHUB_WEBHOOK_SECRET`

The GitHub App requests user authorization during installation, so its User
authorization callback is `https://<tenant>/auth/github/callback` and GitHub's
Setup URL field is intentionally unavailable. Keep **Redirect on update**
enabled: the same callback dispatches `installation_id`/`setup_action` returns
from installs and repository-selection updates before deep-linking to Beeline.
The webhook URL is `https://<tenant>/auth/github/webhook` with the `installation`
and `installation_repositories` events enabled. The older
`/auth/github/installed` and `/auth/github/install/callback` routes remain only
as compatibility aliases. Body daemons obtain short-lived tokens from this
service for clone, fetch, push, land, rename, preview, and CI reads; the App
private key stays here.

Production uses `https://usebeeline.app/auth/github/callback`; the tenant list
also keeps `https://relay.buzzrouter.com/auth/github/callback` valid so stored
legacy relay URLs continue their OAuth ceremony on the same origin where it began.

HTTP OIDC endpoints are accepted only for local emulators when
`BUZZY_AUTH_ALLOW_INSECURE_OIDC=true` and `NODE_ENV` is not `production`.

## Local device emulator

`npm run dev:emulator -w @beeline/auth` runs the same auto-approving OIDC shape
used by the hermetic suite plus an in-memory auth service. It listens on
`127.0.0.1:8790` (provider) and `127.0.0.1:8789` (auth). For Android, reverse
both ports with `adb reverse`, and build Metro with
`EXPO_PUBLIC_BUZZY_RELAY_URL=http://127.0.0.1:8789`. This mode deliberately
uses a non-`__Host-` browser cookie because the loopback fixture is HTTP; the
production default remains `Secure` and `__Host-` prefixed.
