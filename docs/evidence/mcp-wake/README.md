# Owner webhook setup

Feature proof, not a defect report. Reproduction identifier: MCP-WAKE-SETUP.

The previous consent and profile surfaces offered no owner entry point for a hosted bot's webhook URL and auth token. The new consent form saves them on Allow; an existing AI-client member exposes an owner-only profile row to set, replace or clear them. Other viewers receive no wake configuration. The stored auth token never returns in a read.

## Service demonstration

Run from the repository root:

```sh
npm run prove:rooms-mcp -- --wake-setup
```

The migrated, built HTTP service completes synthetic GitHub sign-in, consent Allow with webhook fields, OAuth redirect and token exchange. A human tags the connected member. The durable outbox sends one POST with the expected bearer header to a local HTTPS receiver double. The same tag path passes after saving setup through the profile operation. Profile reads contain only the URL and boolean key status. The pre-existing tag/DM, MCP reply and disconnect proofs also pass.

Only the external identity provider and webhook receiver are doubles. The proof transport maps its asserted public HTTPS destination to a loopback TLS server; production delivery still uses the unchanged public-address validation and pinned HTTPS transport. No production bot credentials or external service calls are used. Ruby owns the live Firstmate reply proof after release.

Server regressions cover consent and profile delivery, another Workspace member's HTTP 403, cleared status, invalid URLs, read/log secrecy, and the plain missing-sealing-key error with transaction rollback. Contract tests strip unrecognized key fields. Mobile management tests exercise the rendered profile's inputs, save receipt, empty replacement draft and clear action.

## Browser demonstration

With the local fixture running:

```sh
MCP_PROOF_PORT=18965 BEELINE_MCP_WEBHOOK_KEY=synthetic-browser-sealing-key node --import tsx scripts/prove-rooms-mcp.mjs --serve
npm run prove:rooms-mcp-consent-browser
```

Real Chromium form submission passed Allow with empty fields, Allow with webhook fields, and Cancel. Each returned the correct redirect; Allow completed token exchange and MCP reads. Edit/Save still works and foreign/null Origin submissions are rejected.

## Captures

Consent captures use the actual built HTTP consent page and synthetic sign-in. Profiles use the production React Native Web profile component in the existing consolidated board fixture. Phone captures are responsive browser views (390 × 844), not native Android/iOS evidence. Web profile captures use (1440 × 1000). All names, links and typed values are synthetic.

| Surface | Bone before | Bone after | Obsidian before | Obsidian after |
| --- | --- | --- | --- | --- |
| Consent | [before](consent-before-light.png) | [after](consent-after-light.png) | [before](consent-before-dark.png) | [after](consent-after-dark.png) |
| Phone profile | [before](profile-before-phone-light.png) | [after](profile-after-phone-light.png) | [before](profile-before-phone-dark.png) | [after](profile-after-phone-dark.png) |
| Web profile | [before](profile-before-web-light.png) | [after](profile-after-web-light.png) | [before](profile-before-web-dark.png) | [after](profile-after-web-dark.png) |

Masked replacement editor: [phone Bone](profile-editor-phone-light.png), [phone Obsidian](profile-editor-phone-dark.png), [web Bone](profile-editor-web-light.png), [web Obsidian](profile-editor-web-dark.png).

## Webhook terminology and pasted headers

Reproduction MCP-WEBHOOK-TOKEN: before this change, the built consent Allow path refused ` Bearer synthetic-wake-key ` with HTTP 400 (`wake_invalid`). The same isolated service proof now redirects with HTTP 302, completes OAuth, and delivers `Authorization: Bearer synthetic-wake-key`. Saving through the profile with lowercase `bearer ` also delivers the same header. Run `npm run prove:rooms-mcp -- --wake-setup`.

The consent and profile labels now read **Webhook URL** and **Auth token**. The shared setter removes a case-insensitive `Bearer ` prefix and surrounding whitespace. HTTP regressions decrypt saved consent, profile and MCP `set_webhook` tokens to verify bare storage; invalid internal spaces, internal controls and an empty prefixed token remain refused. A token beginning with `bearer` without a following space stays intact.

The after captures and masked editor captures above were refreshed in Bone and Obsidian. Profile phone shots remain responsive browser captures, using the production component; consent shots use the built HTTP service. Chromium submits empty Allow, prefixed-token Allow, and Cancel successfully. No production identity-provider credentials or real bot receiver are used. Terminology is a feature, not a defect report.
