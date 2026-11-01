# Next-morning check-in: approved mock A

Feature proof **CHECKIN-A** (not a defect report).

The email now shows the person's starter agents as tilted face stickers, the Beeline mark and wordmark, the speaker's avatar beside the unchanged message in a bubble, the two-agent together line, and the brass reply button. Bone is the inline fallback; Obsidian uses the mail client's dark-mode media query. A one-agent Room has one sticker and no together line.

## Approval provenance

- Owner: lunchboxfortwo.
- Approval message: `d0055c3b47e878e0b69dc132ccc2710e1882add0356a0afe10d3225bbe70d398` — “@ruby love A. Go”.
- Approved file: **Check-in email mock v2: faces or flat**, attachment `38160bf2-0120-458d-8643-fd8fc9770027`.
- SHA-256: `bc2d8d4ebeb63a2dc4c11701e75b2568db178c49e061002cd32e779d3c52233d`.
- Unmodified approved source: [approved-mock-v2.html](approved-mock-v2.html). Only direction A is implemented; B is retained solely because this file is the exact approved attachment.

## Demonstrated

`comparison.html` contains all eight side-by-side screenshots: approved A on the left, real built email on the right. Individual PNG names encode the theme, agent count, and viewport width (390 or 600 pixels). The approved two-agent mock remains the reference for both roster sizes. Sample identities have their own deterministic colours, so their hues differ from the mock's illustrative identities.

The proof starts the built server with an isolated in-memory PostgreSQL-compatible database, renders the actual email HTML in headless Chrome, loads all PNGs through the unauthenticated built server endpoints, and captures both colour schemes and viewport widths. It asserts the bubble's exact text, that every hosted image decodes, and no horizontal overflow. These are browser captures, not inbox captures: the new image routes are not deployed and production Resend configuration is being handled separately. Gmail/Outlook-specific dark-mode behaviour remains subject to those clients' support; inline light styles remain readable without the media query.

Run from the repository root:

```sh
npm run corner:prepare
npx turbo run build --filter=@beeline/server...
node --import tsx apps/server/scripts/prove-checkin-email.mjs
npm run test -w @beeline/server -- src/next-day-checkin.test.ts src/email-art.test.ts
npm run typecheck
npm run dead-code
npm run lint:workflow-paths
```

The server tests exercise one/two starter rosters, owner/Room/starter/removal filtering, exact escaping and line breaks, the public default-animal PNG path, cacheable bytes, invalid parameter bounds, missing agents, both logo variants, and an uploaded portrait overriding the default face. Existing delivery tests continue to cover the subject/plain text, idempotency and send-once behaviour.

## Art maintenance

`npm run email:art -w @beeline/server` regenerates the server's static animal geometry, contrast edge layer, deterministic identity palette and logo from the mobile sources. `email-art.test.ts` rejects stale generated art. The mobile interface itself is unchanged.

The public PNG route never fetches arbitrary URLs or returns identity metadata. It accepts a fixed set of image sizes and tilts, limits simultaneous face rasterization, bounds the in-process image cache, and sends a short public cache lifetime. Custom agent pictures use the existing normalized `agent_avatars` bytes, including uploaded profile images.
