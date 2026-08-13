# @beeline/push-gateway

Android-only FCM gateway for Beeline. It accepts an FCM device registration,
subscribes to kind-9 channel events on the Buzz relay, resolves current channel
visibility through ACL-scoped reads, and sends message-preview Firebase notifications
to registered members other than the event author.

The WebSocket subscription wakes an ACL-scoped bridge poll. The bridge queries
with each registered public key (never a secret key), so private-channel reads
are limited to channels that identity can already access.

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
| `BUZZY_RELAY_HOST`               | subscription origin host               | Relay tenant authority sent to the private query origin                            |
| `BUZZY_RELAY_SUBSCRIPTION_URL`   | same as `BUZZY_RELAY_URL`              | Authenticated WebSocket event-wakeup origin                                        |
| `BUZZY_PUSH_HOST`                | `127.0.0.1`                            | Registration HTTP bind host                                                        |
| `PORT`                           | `8788`                                 | Registration HTTP port (the public tunnel targets this port)                       |
| `BUZZY_PUSH_REGISTRY_FILE`       | `.data/registrations.json`             | Local token registry path                                                          |
| `BUZZY_PUSH_DELIVERY_STATE_FILE` | registry directory + `deliveries.json` | Durable event-id ledger and recipient cursors                                      |
| `BUZZY_PUSH_POLL_INTERVAL_MS`    | `1500`                                 | ACL-scoped relay poll interval                                                     |

`POST /registrations` accepts `{ "pubkey", "token", "platform": "android" }`.
The response and logs never contain the FCM token. The v1 registry is a local
JSON file written mode 0600; it survives normal restarts, but is local to one
gateway host and is lost if that file is removed. Re-importing or generating a
Buzz identity registers the device, and each mobile cold start refreshes the
binding in case Firebase rotated the device token.

The separate delivery-state file is written atomically beside the registry. It
reserves each event-id/recipient attempt before calling FCM and never retries an
ambiguous attempt. Delivered ids are retained for 30 days and capped at 50,000;
durable per-recipient cursors keep pruned backlog events permanently ineligible.
Checked-in `ui-demo-*`, change-review demo, and room-invite live-test fixtures
are suppressed before any FCM call as a second safety boundary.

## Notification content and deployment

Message notifications show the relay event's trimmed text and the cached display
names resolved through the same recipient-authorized relay reader. This means
message text is intentionally visible on the Android lock screen. The preview
policy is localized in `mapping.ts` so a future per-device hide-preview setting
can select the generic form without changing relay lookup or delivery code.

Changes under this service require a push-gateway redeploy. Changes to the
Android notification channel label require a new APK; the application label is
already Beeline.

The production deployment uses a loopback-only query origin and the public,
auth-enforced relay only for its authenticated WebSocket wakeup. See
[`deploy/README.md`](deploy/README.md).
