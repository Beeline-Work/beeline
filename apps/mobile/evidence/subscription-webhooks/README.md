# Webhook subscription detail proof

Feature work, not a defect report. The approved v3 mock is the brief attachment with
SHA-256 `a7b3981ad74588eb1dec7511167a2671690209849459b8ec7bf7ba2c409d8342`.

The actual `settings/subscription.tsx` screen and existing PageHeader, SettingsRow,
and ScheduledWorkDetail components are bundled with React Native Web. Native adapters,
navigation and service responses use explicit fixtures; this is a browser stand-in
for the signed-in phone, without creating production subscriptions. The sender path
is separately exercised through the local HTTP server and real daemon/phone operations
against isolated PostgreSQL-compatible PGlite, including an actual saved-workflow start.

The screenshots show steady, after Show, and rotate confirmation at 390 CSS pixels
in Obsidian and Bone. The first visual pass found a long token clipped by SettingsRow's
default two-line description; the final screen renders full selectable link/token text.
The final Obsidian screen matches the mock's components, row order, spacing, typography,
actions, two-tap confirmation, and danger/quiet tones. Link, token and calls are fixtures;
Bone applies the same existing theme tokens.

The capture script also checks own-title rendering, Show/Copy, link copying, rotate,
Cancel, service calls, hidden Link for non-admins, recoverable errors, and no horizontal
overflow. It captures the screen before exercising extra Copy feedback states.

From the repository root:

```sh
node apps/mobile/scripts/render-subscription-webhook-proof.mjs
npm install --prefix /tmp/beeline-webhook-browser --no-audit --no-fund playwright-core
PLAYWRIGHT_CORE_PATH=/tmp/beeline-webhook-browser/node_modules/playwright-core/index.mjs node apps/mobile/scripts/subscription-webhook-proof/capture.mjs
```

The capture runner uses installed `/usr/bin/google-chrome` and writes to
`.verification/subscription-webhook/`. The six PNGs alongside this file are that output.

Server proof:

```sh
npm test --workspace @beeline/server -- --maxWorkers=1 --no-file-parallelism src/subscription-webhooks.test.ts
```

The HTTP proof creates through an authorized daemon turn, reveals through the phone
operation, sends bearer and raw-body HMAC calls (header and query), retries a delivery,
rotates, rejects the old token, starts the fixed saved workflow despite malicious
payload fields, links the recorded call to its run, then stops and rejects further calls.
Other cases prove Workspace-admin creation/control, no Link metadata for Room-only admins,
rate limit, body limit, bounded history, and refusal after owner demotion or Room archival.
