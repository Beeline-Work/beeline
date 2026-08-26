# @beeline/push-gateway

Beeline's Postgres-adjacent push and channel-snapshot gateway. It accepts an
Android FCM device registration, tails kind-9 channel events from Buzz's
authoritative database, and sends Firebase notifications to registered members
other than the event author. Beside that existing feed, one durable materializer
builds the membership-gated `channel-snapshot-v1` Room/corner read view.

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
| `BUZZY_PUSH_DELIVERY_STATE_FILE`   | registry directory + `deliveries.json` | Durable event-id ledger and recipient cursors                                      |
| `BUZZY_PUSH_POLL_INTERVAL_MS`      | `1500`                                 | Member-scoped database poll interval                                               |
| `BUZZY_PUSH_FEED_HEARTBEAT_MS`     | `60000`                                | Feed heartbeat interval; production logs normalize its event count to events/min   |
| `BUZZY_SNAPSHOT_PUBLIC_ORIGIN`     | gateway bind origin                    | Exact public origin used to verify snapshot NIP-98 proofs                          |
| `BUZZY_SNAPSHOT_AUTH_BASE_URL`     | `http://127.0.0.1:8789`                | Private auth-service origin for materializer succession lookups                    |
| `BUZZY_SNAPSHOT_INTERNAL_TOKEN`    | —                                      | Private auth bearer; mandatory in production                                       |
| `BUZZY_SNAPSHOT_POLL_INTERVAL_MS`  | `1000`                                 | Durable dirty-work polling interval                                                |
| `BUZZY_SNAPSHOT_BURST_COALESCE_MS` | `75`                                   | Minimum age before a newly dirty channel is claimed                                |

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

The separate delivery-state file is written atomically beside the registry. It
reserves each event-id/recipient attempt before calling FCM and never retries an
ambiguous attempt. Delivered ids are retained for 30 days and capped at 50,000;
durable per-recipient cursors keep pruned backlog events permanently ineligible.
FCM eligibility fails closed unless the Room has an immutable kind-9007 create
linked to a self-linked persistent Workspace create. The final pre-FCM boundary
then suppresses explicit `fixture` tags; `change-review*`, `ui-test`, `ui-demo`,
`uidemo`, and `test-fixture` markers; fixture names/repositories including
`ui-demo-*`, `research-no-findings-*`, `review-corner-*`, `*-uidemo-*`, and
room-invite repair/visibility fixtures; and all Rooms linked to an obviously
test/demo/fixture/throwaway Workspace. The active `channel_members` row remains
the per-recipient delivery authority for every genuine eligible Room.

## Channel snapshots

`GET /snapshot/channel/<uuid>` requires a fresh kind-27235 NIP-98 proof with
exactly the configured public URL, method `GET`, and one nonce. Proof IDs are
durably replay guarded. The signer is the only viewer input; the serving query
resolves the relay tenant and joins an active `channel_members` row on every
request. A missing channel and a non-member therefore return the same `404`.
Responses are `private, no-store` and vary on `Authorization`.

The response contains one integrity-hashed, versioned normalized read-model
snapshot: the requested Room/corner, its parent and sibling corner summaries,
current metadata/lifecycle and roster, repository and review/approval summary,
up to 30 projected conversation rows, and an inclusive WebSocket cursor. It is
hard-capped at 256 KiB; attachments remain link metadata only. Missing,
incompatible, corrupt, or more-than-30-second-behind rows return typed
`503 snapshot_not_ready`, never an empty transcript.

Postgres triggers coalesce event, channel, membership, and identity changes into
one durable dirty row per `(relay_tenant_id, channel_id)`. A bounded fair worker
claims them with `FOR UPDATE SKIP LOCKED`, rebuilds through the shared
`@beeline/buzz-client` parser/reducer/selectors, resolves key succession through
the auth sidecar, and atomically replaces the JSONB row. `/snapshot/health`
reports worker warmth, queue depth, and oldest dirty age. `/health` remains the
independent FCM readiness check, so unavailable Firebase credentials do not
prevent already-built snapshots from being served.

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

Changes under this service require a push-gateway redeploy. Changes to the
Android notification channel label require a new APK; the application label is
already Beeline.

Production runs the gateway as `push-gateway` in `relay-stack/prod/compose.yml`.
The tracked relay-front proxies both `/push/` and path-preserving `/snapshot/`
to that service on the Compose network. The materializer and replay ledger live
in relay Postgres; the existing host deploy builds the image, applies the tracked
Compose/nginx configuration, and verifies both health surfaces on merge. Do not
deploy it manually. Preserve the existing `secrets/` and `state/` directories;
the one-time legacy systemd retirement and persistence checks are documented in
[`deploy/README.md`](deploy/README.md).
