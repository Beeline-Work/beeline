# @beeline/push-gateway

Android-only FCM gateway for Beeline. It accepts an FCM device registration,
reads kind-9 channel events through the trusted recipient-scoped relay bridge,
resolves current channel visibility through the same ACL-scoped reads, and sends
message-preview Firebase notifications to registered members other than the event
author.

The gateway queries with each registered public key (never a secret key), so
private-channel reads are limited to channels that identity can already access.
This feed intentionally does not use a global WebSocket subscription: Buzz stores
kind-9 messages as channel-scoped events and excludes them from global live fan-out.
A channel-scoped WebSocket subscription would require the registered person's
private signing key, which the gateway must never collect. Failed feed reads retry
with bounded exponential backoff, and one heartbeat per minute reports the observed
event rate and successful/failed poll counts.

## Run

```sh
BUZZY_PUSH_SA_FILE=/absolute/path/to/fcm-service-account.json \
  npm run dev -w @beeline/push-gateway
```

The service account file stays outside the repository. Do not log or commit it.

| Variable                         | Default                                | Purpose                                                                            |
| -------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `BUZZY_PUSH_SA_FILE`             | —                                      | Firebase service-account path; used when `GOOGLE_APPLICATION_CREDENTIALS` is unset |
| `GOOGLE_APPLICATION_CREDENTIALS` | —                                      | Standard Google credential path                                                    |
| `BUZZY_RELAY_URL`                | `http://127.0.0.1:3010`                | ACL-scoped HTTP query origin                                                       |
| `BUZZY_RELAY_HOST`               | query origin host                      | Relay tenant authority sent to the private query origin                            |
| `BUZZY_PUSH_HOST`                | `127.0.0.1`                            | Registration HTTP bind host                                                        |
| `PORT`                           | `8788`                                 | Registration HTTP port (Compose-internal in production)                            |
| `BUZZY_PUSH_REGISTRY_FILE`       | `.data/registrations.json`             | Local token registry path                                                          |
| `BUZZY_PUSH_DELIVERY_STATE_FILE` | registry directory + `deliveries.json` | Durable event-id ledger and recipient cursors                                      |
| `BUZZY_PUSH_POLL_INTERVAL_MS`    | `1500`                                 | ACL-scoped relay poll interval                                                     |
| `BUZZY_PUSH_FEED_HEARTBEAT_MS`   | `60000`                                | Feed heartbeat interval; production logs normalize its event count to events/min   |

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
test/demo/fixture/throwaway Workspace. ACL-scoped reads remain the per-recipient
delivery authority for every genuine eligible Room.

Every candidate relay event produces one `[push] decision` line with its full
event id and Room id, recipient, `notify`/`skip` verdict, exact reason, and send
counts when FCM was attempted. To audit the metadata and fixture gates against
the private production query path without sending FCM, run:

```sh
BUZZY_PUSH_REGISTRY_FILE=/path/to/registrations.json \
BUZZY_RELAY_URL=http://127.0.0.1:3410 \
BUZZY_RELAY_HOST=relay.buzzrouter.com \
  npm run audit:suppression -w @beeline/push-gateway -- <pubkey-prefix> [room-id ...]
```

## Notification content and deployment

Message notifications show the relay event's trimmed text and the cached display
names resolved through the same recipient-authorized relay reader. This means
message text is intentionally visible on the Android lock screen. The preview
policy is localized in `mapping.ts` so a future per-device hide-preview setting
can select the generic form without changing relay lookup or delivery code.

Changes under this service require a push-gateway redeploy. Changes to the
Android notification channel label require a new APK; the application label is
already Beeline.

The live production host currently runs `buzzy-push-gateway.service` as a user
systemd unit, with `~/buzzy-push-gateway/current` pointing at an immutable
release. To apply a committed gateway update, the operator prepares and builds
a new release, atomically repoints `current`, then runs
`systemctl --user restart buzzy-push-gateway.service`. Verify `/push/health` and
the `[push] feed live`, `[push] feed heartbeat`, and decision lines with
`journalctl --user -u buzzy-push-gateway.service`.
Preserve the existing `secrets/` and `state/` directories throughout. The
checked-in Compose deployment remains a separate target topology; do not run
both pollers against one delivery ledger. See [`deploy/README.md`](deploy/README.md).
