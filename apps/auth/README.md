# `@beeline/auth`

This is Beeline's narrow OIDC-to-Nostr-public-key binding service. It owns the
Authorization Code + PKCE + nonce ceremony and a durable one-use binding
transaction. It does not issue relay credentials, grant roles or membership,
participate in merge decisions, or accept a Nostr secret key.

## Protocol

1. `GET /auth/oidc/start` resolves the tenant from the request `Host`, stores a
   hashed one-use OAuth state bound to an HttpOnly browser-session cookie, with
   a nonce and PKCE verifier, and redirects to the configured provider.
2. `GET /auth/oidc/callback` atomically consumes the flow, exchanges the code
   server-side, validates the pinned issuer/audience/RS256 token and nonce, and
   returns one short-lived bind ticket and the exact fields the device key must
   sign. The database stores only the SHA-256 ticket hash.
3. `POST /auth/oidc/bind` accepts `{ "ticket": "...", "event": { ... } }`.
   The signed kind `24250` event must contain exactly one each of `t`, `ticket`,
   `challenge`, `provider`, `audience`, `subject`, and `community`, all matching
   the ticket, and be inside its timestamp window. Ticket consumption and the
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
PostgreSQL service, then route only `/auth/oidc/` to it from `relay-front` while
preserving the original `Host`. All other relay traffic remains on Buzz. Adding
that production route, provisioning the real Google OAuth client, and deploying
the service are intentionally deferred.

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

HTTP OIDC endpoints are accepted only for local emulators when
`BUZZY_AUTH_ALLOW_INSECURE_OIDC=true` and `NODE_ENV` is not `production`.
