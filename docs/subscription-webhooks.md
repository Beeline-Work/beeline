# Incoming subscription webhooks

A Workspace admin in a Room, or a human member in a DM, asks an agent to create an event subscription with `source: webhook`,
`event: webhook.called`, a title, `when: On webhook call`, and a prompt or saved workflow.
Creation uses the existing `wake` tool in the target Room or corner. Tokens are never
returned to that tool or posted in chat.

Open the Room or DM menu → Schedules and subscriptions → the subscription. Workspace admins
in Rooms and human members in their own DMs can copy
the link, Show and copy its token, Rotate it, inspect recent calls, or Stop it. Rotation
invalidates the old token immediately. Delivery rechecks the current token owner: Workspace
admin for a Room, human DM participant with current membership for a DM. Other viewers
receive no link or token metadata.

Send `POST /hooks/<subscription UUID>` on the server host with
`Authorization: Bearer <token>`. The token begins `bl_whk_` and contains 32 random bytes.
The body is limited to 64 KiB. JSON and plain text are accepted as outside data;
the sender cannot select a prompt, workflow, agent, or destination.
The transcript labels any preview “Caller's message:” and quotes at most 280 characters
(including a trailing ellipsis when shortened). It uses plain text with Markdown,
mentions and URL detection disabled. A JSON body's `message` or `text` field supplies
the preview when present; otherwise the body itself is shown. The full body still
reaches the agent as quoted outside data.

For HMAC senders, compute HMAC-SHA256 over the exact raw body bytes using the full token
as the key. Send the hexadecimal digest in `X-Beeline-Signature` (optionally prefixed
`sha256=`), or in the `signature` query parameter when headers cannot be configured.
Never put the bearer token in the URL. The server logs only the path, without query
parameters, headers, or tokens.

Set `X-Beeline-Delivery` or the `delivery` query parameter to a unique delivery ID
(up to 200 characters), and reuse it when retrying. Without one, identical bodies are
considered retries. Successful deliveries are deduplicated for one day, independently
of the recent-call history. The link permits 30 calls per minute, including refusals.

Responses: 200 for a queued wake or skipped retry, 400 for an invalid delivery ID,
401 for failed authentication, 403 when the agent, Room, or authorizing owner is no
longer available, 404 for an unknown/stopped link, 413 for an oversized body, and 429
for the rate limit. A queued wake does not mean the agent has finished its action.

The server retains the most recent 50 calls with outcome, byte count, timestamp,
and the wake message. A subsequently started saved workflow attaches its actual run ID;
the detail row opens that run, or the wake in the transcript while it has no run.

Tokens use the existing AES-256-GCM secret encryption (`sealSecrets`) with the server's
configured `GITHUB_CLIENT_SECRET`. Creation fails closed if that key is absent.
Rotation and ingress lock the same subscription row. Agent and owner memberships and
Room archival are checked again before each wake.

Validation and the approved mock comparison: [UI evidence](../apps/mobile/evidence/subscription-webhooks/README.md).
