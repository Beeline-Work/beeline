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

| Variable                         | Default                    | Purpose                                                                            |
| -------------------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `BUZZY_PUSH_SA_FILE`             | —                          | Firebase service-account path; used when `GOOGLE_APPLICATION_CREDENTIALS` is unset |
| `GOOGLE_APPLICATION_CREDENTIALS` | —                          | Standard Google credential path                                                    |
| `BUZZY_RELAY_URL`                | `http://127.0.0.1:3010`    | Buzz relay HTTP origin; WS is derived by `@beeline/buzz-client`                    |
| `BUZZY_PUSH_HOST`                | `127.0.0.1`                | Registration HTTP bind host                                                        |
| `PORT`                           | `8788`                     | Registration HTTP port (the public tunnel targets this port)                       |
| `BUZZY_PUSH_REGISTRY_FILE`       | `.data/registrations.json` | Local token registry path                                                          |
| `BUZZY_PUSH_POLL_INTERVAL_MS`    | `1500`                     | ACL-scoped relay poll interval                                                     |

`POST /registrations` accepts `{ "pubkey", "token", "platform": "android" }`.
The response and logs never contain the FCM token. The v1 registry is a local
JSON file written mode 0600; it survives normal restarts, but is local to one
gateway host and is lost if that file is removed. Re-importing or generating a
Buzz identity registers the device, and each mobile cold start refreshes the
binding in case Firebase rotated the device token.

## Notification content and deployment

Message notifications show the relay event's trimmed text and the cached display
names resolved through the same recipient-authorized relay reader. This means
message text is intentionally visible on the Android lock screen. The preview
policy is localized in `mapping.ts` so a future per-device hide-preview setting
can select the generic form without changing relay lookup or delivery code.

Changes under this service require a push-gateway redeploy. Changes to the
Android notification channel label require a new APK; the application label is
already Beeline.
