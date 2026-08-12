# @beeline/push-gateway

Android-only FCM gateway for Buzzy. It accepts an FCM device registration,
subscribes to kind-9 channel events on the Buzz relay, resolves current channel
visibility through ACL-scoped reads, and sends generic Firebase notifications
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

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUZZY_PUSH_SA_FILE` | — | Firebase service-account path; used when `GOOGLE_APPLICATION_CREDENTIALS` is unset |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Standard Google credential path |
| `BUZZY_RELAY_URL` | `http://127.0.0.1:3010` | Buzz relay HTTP origin; WS is derived by `@beeline/buzz-client` |
| `BUZZY_PUSH_HOST` | `127.0.0.1` | Registration HTTP bind host |
| `PORT` | `8788` | Registration HTTP port (the public tunnel targets this port) |
| `BUZZY_PUSH_REGISTRY_FILE` | `.data/registrations.json` | Local token registry path |
| `BUZZY_PUSH_POLL_INTERVAL_MS` | `1500` | ACL-scoped relay poll interval |

`POST /registrations` accepts `{ "pubkey", "token", "platform": "android" }`.
The response and logs never contain the FCM token. The v1 registry is a local
JSON file written mode 0600; it survives normal restarts, but is local to one
gateway host and is lost if that file is removed. Re-importing or generating a
Buzz identity registers the device, and each mobile cold start refreshes the
binding in case Firebase rotated the device token.

## Privacy

Notification content is always generic (`New activity in <channel>` or a merge
review prompt). Relay event `content` is never copied into FCM payloads. This is
safe whether the relay exposes plaintext or only E2E ciphertext to the gateway;
the gateway does not attempt to decrypt messages.
