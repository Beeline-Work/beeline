# @beeline/push-gateway

Beeline's Postgres-adjacent relay service. One process hosts push delivery,
repository-event ingestion, and the direct Room indexer. It accepts an
Android FCM device registration, tails kind-9 channel events from Buzz's
authoritative database, and sends Firebase notifications to registered members
other than the event author. The same process polls GitHub repository activity
and serves bounded, membership-gated paint DTOs directly from authoritative
Postgres. There is no stored view, dirty queue, cursor, digest, or read cache.

The default policy is intentionally quiet: a recipient gets a push only for an
explicit `p`-tag mention, a direct message, or an agent's transition to
waiting-on-human (a question, needs-attention card, or merge-review request).
Ordinary human/agent chat, agent narration, activity frames, and member joins
stay in-app. Every candidate still emits a decision trace, including the exact
fatigue-policy skip reason. Android separates `mentions`, `attention`, and
`activity` (direct-message) channels so each class can be tuned in system
settings.

Every feed query joins the event's server-stamped `community_id` and channel to an
active `channel_members` row for the registered recipient. The gateway never trusts
a client-authored community tag and never uses hostname-to-community resolution.
That keeps private-room ACLs intact while making relay aliases and domain migrations
irrelevant to push liveness. Failed database reads retry with bounded exponential
backoff, and one heartbeat per minute reports events that actually reached the
gateway decision path plus successful/failed poll counts.

## Run

```sh
BUZZY_PUSH_SA_FILE=/absolute/path/to/fcm-service-account.json \
BUZZY_PUSH_DATABASE_URL=postgres://buzz:password@127.0.0.1:5433/buzz \
  npm run dev -w @beeline/push-gateway
```

The service account file stays outside the repository. Do not log or commit it.

| Variable                           | Default                                | Purpose                                                                            |
| ---------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `BUZZY_PUSH_SA_FILE`               | —                                      | Firebase service-account path; used when `GOOGLE_APPLICATION_CREDENTIALS` is unset |
| `GOOGLE_APPLICATION_CREDENTIALS`   | —                                      | Standard Google credential path                                                    |
| `BUZZY_PUSH_DATABASE_URL`          | `DATABASE_URL`                         | Buzz Postgres connection; startup fails if neither variable is set                 |
| `BUZZY_PUSH_HOST`                  | `127.0.0.1`                            | Registration HTTP bind host                                                        |
| `PORT`                             | `8788`                                 | Registration HTTP port (Compose-internal in production)                            |
| `BUZZY_PUSH_REGISTRY_FILE`         | `.data/registrations.json`             | Local token registry path                                                          |
| `BUZZY_PUSH_POLL_INTERVAL_MS`      | `1500`                                 | Member-scoped database poll interval                                               |
| `BUZZY_PUSH_FEED_HEARTBEAT_MS`     | `60000`                                | Feed heartbeat interval; production logs normalize its event count to events/min   |
| `BUZZY_INDEXER_PUBLIC_ORIGIN`      | gateway bind origin                    | Exact public origin used to verify surface NIP-98 proofs                           |
| `BEELINE_GITHUB_APP_ID`            | —                                      | GitHub App id for the hosted repository-events consumer                            |
| `BEELINE_GITHUB_APP_PRIVATE_KEY`   | —                                      | GitHub App private key; mandatory for the hosted consumer                          |
| `BEELINE_EVENTS_STATE_DIR`         | XDG state + `beeline/events`           | Repository-events signing identity                                                  |

For the isolated `relay-stack/compose.yml` gate stack, Compose sets
`BUZZY_MATERIALIZER_DISABLE_PUSH_DELIVERY=true` and
`BUZZY_MATERIALIZER_DISABLE_REPOSITORY_EVENTS=true`. This keeps the direct
RoomView indexer local without an FCM service-account or any operator runtime
state; production leaves both consumers enabled.

`POST /registrations` accepts
`{ "pubkey", "token", "platform": "android", "environment": "physical" }`.
`environment` is optional for legacy clients, but registrations explicitly marked
`test`, `emulator`, or `simulator` are acknowledged and discarded. The mobile
client sends `physical` or `emulator` from `expo-device`.
`DELETE /registrations` accepts `{ "pubkey", "token" }` with an exact-method/URL
NIP-98 authorization from that pubkey, and removes only that device binding.
`POST /test-send` accepts `{ "pubkey" }` with the same exact-method/URL NIP-98
authorization from that pubkey. It sends a real FCM test notification to every
registered device and returns aggregate counts plus one success/failure record
per opaque device id. Responses and logs never expose FCM tokens. The v1 registry is a local
JSON file written mode 0600; it survives normal restarts, but is local to one
gateway host and is lost if that file is removed. Re-importing or generating a
Buzz identity registers the device, and each mobile cold start refreshes the
binding in case Firebase rotated the device token.

The process stores the push reservation document in Postgres. It reserves each event-id/recipient
attempt before calling FCM and never retries an ambiguous attempt. Delivered
ids are retained for 30 days and capped at 50,000;
durable per-recipient cursors keep pruned backlog events permanently ineligible.
FCM eligibility fails closed unless the Room has an immutable kind-9007 create
linked to a self-linked persistent Workspace create. The final pre-FCM boundary
then suppresses explicit `fixture` tags; `ui-test`, `ui-demo`, `uidemo`, and
`test-fixture` markers; fixture names/repositories including
`ui-demo-*`, `research-no-findings-*`, `review-corner-*`, `*-uidemo-*`, and
room-invite repair/visibility fixtures; and all Rooms linked to an obviously
test/demo/fixture/throwaway Workspace. The active `channel_members` row remains
the per-recipient delivery authority for every genuine eligible Room.

## Direct surface indexer

The indexer exposes seven bounded reads — `/workspaces`, `/workspace/:id`,
`/workspace/:id/chats`, `/workspace/:id/agents/:pubkey`, `/room/:id`,
`/room/:id/corners`, and `/room/:id/messages` — plus `POST /invite/resolve`,
`POST /agent-pairing/claim`, and `POST /agent-pairing/abandon`. Every route
requires an exact fresh NIP-98 reader identity. The reads join current
membership in the same SQL statement; a
missing object and a non-member return the same `404`. Invite resolution
intentionally skips membership, hashes the opaque token from its body, verifies
the current minter and Workspace, and returns only name, avatar, and expiry.

`POST /agent-pairing/claim` is the other NIP-98-authenticated boundary. It
accepts a single-use pairing code, atomically reserves its globally readable
marker for the signing agent identity, and grants Workspace membership before
canonical relay membership is published. A rollback-aware client advertises
the `pairing-room-rollback` capability to also inherit the eligible current
top-level Rooms of the code's minter; legacy clients remain Workspace-only. The
response lists any attached Room ids.
`POST /agent-pairing/abandon` consumes that authenticated agent's recorded
claim generation and removes only the memberships it created, leaving later
independent grants intact.

`/room/:id` addresses both top-level Rooms and corners. Its one bounded query is
paint-complete for a cold chat open: metadata, viewer permissions, resolved
roster, latest durable rows with reply proofs, parent briefing, sibling corners,
repository, and review descriptors. Media and patch bodies remain lazy assets.
Responses are `private, no-store`; there is no replay ledger because reads are
idempotent.

Every candidate database event produces one `[push] decision` line with its full
event id and Room id, recipient, `notify`/`skip` verdict, exact reason, and send
counts when FCM was attempted. To audit the metadata and fixture gates against
the legacy private relay path without sending FCM, run:

```sh
BUZZY_PUSH_REGISTRY_FILE=/path/to/registrations.json \
BUZZY_RELAY_URL=http://127.0.0.1:3410 \
BUZZY_RELAY_HOST=relay.buzzrouter.com \
  npm run audit:suppression -w @beeline/push-gateway -- <pubkey-prefix> [room-id ...]
```

## Notification content and deployment

Eligible notifications show the relay event's trimmed text and cached display
names resolved from recipient-authorized database rows. Agent soul names take
precedence over deterministic seed fallbacks. Message text is intentionally
visible on the Android lock screen; the preview policy is localized in
`mapping.ts` so a future per-device hide-preview setting can select the generic
form without changing relay lookup or delivery code.

Changes under this service require a materializer redeploy. Changes to the
Android notification channel label require a new APK; the application label is
already Beeline.

Production runs one `materializer` service in `relay-stack/prod/compose.yml`.
The tracked relay-front proxies `/push/` plus the eight indexer routes to it on
the Compose network. The host deploy builds the image, retires the old
`beeline-events.service`, applies the tracked Compose/nginx configuration, and
verifies the unsigned indexer refusal plus push health on merge. Do not deploy
it manually. Preserve the existing push registry and repository-events signing
identity directories.
