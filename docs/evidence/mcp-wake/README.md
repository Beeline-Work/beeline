# Owner wake setup

Feature proof, not a defect report. Reproduction identifier: MCP-WAKE-SETUP.

The previous consent and profile surfaces offered no owner entry point for a hosted bot's wake URL and bearer key. The new consent form saves them on Allow; an existing AI-client member exposes an owner-only profile row to set, replace or clear them. Other viewers receive no wake configuration. The stored key never returns in a read.

## Service demonstration

Run from the repository root:

```sh
npm run prove:rooms-mcp -- --wake-setup
```

The migrated, built HTTP service completes synthetic GitHub sign-in, consent Allow with wake fields, OAuth redirect and token exchange. A human tags the connected member. The durable outbox sends one POST with the expected bearer header to a local HTTPS receiver double. The same tag path passes after saving setup through the profile operation. Profile reads contain only the URL and boolean key status. The pre-existing tag/DM, MCP reply and disconnect proofs also pass.

Only the external identity provider and webhook receiver are doubles. The proof transport maps its asserted public HTTPS destination to a loopback TLS server; production delivery still uses the unchanged public-address validation and pinned HTTPS transport. No production bot credentials or external service calls are used. Ruby owns the live Firstmate reply proof after release.

Server regressions cover consent and profile delivery, another Workspace member's HTTP 403, cleared status, invalid URLs, read/log secrecy, and the plain missing-sealing-key error with transaction rollback. Contract tests strip unrecognized key fields. Mobile management tests exercise the rendered profile's inputs, save receipt, empty replacement draft and clear action.

## Browser demonstration

With the local fixture running:

```sh
MCP_PROOF_PORT=18965 BEELINE_MCP_WEBHOOK_KEY=synthetic-browser-sealing-key node --import tsx scripts/prove-rooms-mcp.mjs --serve
npm run prove:rooms-mcp-consent-browser
```

Real Chromium form submission passed Allow with empty fields, Allow with wake fields, and Cancel. Each returned the correct redirect; Allow completed token exchange and MCP reads. Edit/Save still works and foreign/null Origin submissions are rejected.

## Captures

Consent captures use the actual built HTTP consent page and synthetic sign-in. Profiles use the production React Native Web profile component in the existing consolidated board fixture. Phone captures are responsive browser views (390 × 844), not native Android/iOS evidence. Web profile captures use (1440 × 1000). All names, links and typed values are synthetic.

| Surface | Bone before | Bone after | Obsidian before | Obsidian after |
| --- | --- | --- | --- | --- |
| Consent | [before](consent-before-light.png) | [after](consent-after-light.png) | [before](consent-before-dark.png) | [after](consent-after-dark.png) |
| Phone profile | [before](profile-before-phone-light.png) | [after](profile-after-phone-light.png) | [before](profile-before-phone-dark.png) | [after](profile-after-phone-dark.png) |
| Web profile | [before](profile-before-web-light.png) | [after](profile-after-web-light.png) | [before](profile-before-web-dark.png) | [after](profile-after-web-dark.png) |

Masked replacement editor: [phone Bone](profile-editor-phone-light.png), [phone Obsidian](profile-editor-phone-dark.png), [web Bone](profile-editor-web-light.png), [web Obsidian](profile-editor-web-dark.png).
