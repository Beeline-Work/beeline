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
4. `GET /auth/oidc/links/:pubkey` requires a fresh, exact-URL/method NIP-98
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
the single Beeline GitHub App installation and `/auth/github/repos/:pubkey`
lists only repositories granted to that installation. The app should be
installed with **All repositories** (the endorsed default) and Contents
read/write plus Metadata read permissions. Daemons mint one-hour installation
tokens for Git smart-HTTP; they do not consult `gh`, credential helpers, or
ambient Git configuration.

GitHub ships dark until **all five** `BEELINE_GITHUB_*` values below are present.
`GET /auth/capabilities` then reports `github: true`; without them it reports
`github: false`, GitHub routes stay unavailable, and the existing Google OIDC
sign-in remains the visible, unchanged mobile path.

Required configuration:

- `DATABASE_URL`
- `BUZZY_AUTH_TENANTS_JSON`, for example
  `[{"host":"relay.example","community":"workspace-id","origin":"https://relay.example"}]`
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

The GitHub App OAuth callback is `https://<tenant>/auth/github/callback`; its
setup URL is `https://<tenant>/auth/github/install/callback`. Body daemons need
the same `BEELINE_GITHUB_APP_ID` and `BEELINE_GITHUB_APP_PRIVATE_KEY` so all clone,
fetch, push, land, rename, preview, and CI reads use installation authority.

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
