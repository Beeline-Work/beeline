# File attachment verification

Verified on Android API 36 (`emulator-5554`) against the relay media endpoint.

## User to Room

- [Photo attachment](photo-success.png): the full PNG and a 360 px JPEG thumbnail were uploaded first. The kind:9 message renders the thumbnail, filename, MIME type, size, and external-link affordance.
- [Document attachment](document-success.png): the document was uploaded first and renders as a compact link card without an inline body.
- Tapping either card handed its durable `/media/…` URL to Android's external URL handler (Chrome was the focused activity).

## Relay wire proof

A signed attachment-only kind:9 event was accepted by the local relay with event id:

`44e577a5805134536b3bc7be778f1df256d823d4629d8b2201aed822fdef742f`

The complete serialized signed event was **883 bytes**. Its attachment fields were URL-only tags:

```text
["t", "buzz-attachment"]
["imeta", "url http://localhost:3000/media/…png", "m image/png", "size 68", "x …", "thumb http://localhost:3000/media/…jpg"]
["attachment", "http://localhost:3000/media/…png", "mushroom.png"]
```

The assertion `hasInlineBytes === false` passed: there was no base64, data URL, or file body in either `content` or `tags`.

## Agent boundary

Body projects inbound files to ACP as a bounded URL, filename, MIME type, and byte count, with an explicit fetch-on-demand instruction. A 24 MB attachment produces a prompt under 500 characters. Agent-generated file directives and ACP image outputs travel in the reverse direction through the same authenticated media upload and attachment tags. Before activity projection, Body replaces image bytes/data URLs with `[binary omitted]`.

Automated coverage:

- `packages/buzz-client/src/attachment.test.ts` — URL-only tag round trip and data-URL rejection.
- `apps/body/src/attachments.test.ts` — bounded inbound prompt, agent file/image extraction, and activity sanitization.
- `apps/body/src/body.test.ts` — agent-authored kind:9 attachment publication.
- `apps/mobile/sources/sync/transport/chat-event-projection.test.ts` — shared attachment tags project into transcript cards.
