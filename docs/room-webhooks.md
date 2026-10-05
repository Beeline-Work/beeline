# Incoming Room webhooks

Open a Room’s actions → **Webhooks** to create, rotate or revoke an incoming URL, or set/clear its signing secret. Only human Room admins (including Workspace owners/admins who belong to the Room) can manage or approve sources. A source is 1–40 lowercase letters, digits or hyphens. Each live source is unique within its Room.

Agents use `request_webhook(source, reason)`. The approval card names the requesting agent, source and reason. Approval resumes that agent’s turn and returns the URL once when the helper claims the resume. The URL is encrypted until delivery and is absent from shared cards, lists and command snapshots. Configure the sender immediately. A repeated claim cannot retrieve it again. The admin can optionally supply a signing secret privately, or explicitly share it in that same private resume. Denied requests and requests unanswered after seven days mint no token. Only one pending request per Room/source is allowed. A new approved request by the original agent rotates its source.

Admins creating or rotating a source see its URL once in settings. Rotation invalidates the previous URL immediately; revocation disables it. Agents can use `list_webhooks` to inspect sources and recent delivery metadata, with no URLs or secrets.

## Send a delivery

Send JSON to `POST /v1/hooks/<token>` (maximum 32 KB). Optional `Idempotency-Key` values are remembered for 24 hours. The source accepts at most 60 deliveries per minute; excess requests return 429. Unknown, revoked or archived-Room URLs return 404.

If a signing secret is configured, include:

- `X-Beeline-Timestamp`: Unix time in seconds, within five minutes of the server’s clock.
- `X-Beeline-Signature`: `sha256=<hex HMAC-SHA256>` using that secret over the timestamp, a literal `.`, and the exact raw request body bytes.

Unsigned, incorrectly signed or stale requests return 401. Oversized bodies return 413; invalid JSON returns 400. Webhook tokens are replaced by `[redacted]` in request and error logs.

## Consume outside data

An agent subscribes with `subscribe_events(["webhook:price-feed"])`. This replaces the agent’s subscriptions; include any existing kinds it still wants. An accepted POST returns `202 { "delivered": n }`, where `n` is the number of subscribed agents. When there is no subscriber, the delivery is logged and no Room message is posted. The latest 200 deliveries per source are retained; deduplication is independent of that history cap.

Payloads are `webhook:<source>` events. They never pass a server-kind trust check and cannot be emitted through `emit_event`. Wake text and prompt assembly use the shared `quoteOutsideData` helper, which labels the origin as untrusted and quotes every payload line. Webhook content is data, never instructions.

This implementation includes subscriptions only. Wait steps, webhook-triggered workflow starts and script steps are separate work. `hasWebhookConsumer` is the seam for their future consumers.
