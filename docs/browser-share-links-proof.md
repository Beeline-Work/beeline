# Shared browser link proof

Reproduction 2026-10-20: opening the production bare share link returned HTTP 403 with zero bytes. Repeated here with curl before implementation. Production's new `/beeline/browser-share` route also shows “Unmatched Route” before deployment.

The candidate adds a public entry page with fixed Beeline web and native destinations. It does not query or disclose the session's Room. Phone authentication, current membership and agent access policy still control capability issuance and viewing. The share tool returns the actual card message id and an app entry link; the internal share URL stays on the card for authenticated streaming.

## Built service stand-in

Run `npm run build` then `node --import tsx scripts/prove-browser-share-link.ts`.

This runs built server modules against isolated PGlite through the mounted HTTP server. The GitHub assertion exchange uses an isolated fixture verifier, not a production login. Under Reproduction 2026-10-20 the same bare-link path now returns 200 with 494 bytes and both Beeline destinations. An unauthenticated phone open returns 401; fixture sign-in followed by `openComputerSession` returns a capability; the viewer returns 200. Revoking Room membership makes the issued capability return 403 with an explanation. Ending the share returns 410 with an explanation.

## App checks

- Server handoff suite: 21 tests pass, including missing/invalid/expired tokens, revoked membership, valid viewer HTML and ended shares.
- Body share/tool suites: 37 tests pass; returned card id and Beeline link are checked.
- API contract suite: 477 tests pass.
- Mobile route, existing viewer, native link delivery and pending-sign-in tests pass.
- Root typecheck, UI policy and workflow path checks pass.
- Web export and Android Hermes export succeed. The exported candidate renders its invalid-link explanation in a desktop browser and Android Chrome on an isolated API 36 emulator. This checks the browser route, not native app takeover or sign-in.

## Acceptance still pending

The candidate is not deployed. The required signed-in walkthrough on `web.usebeeline.app` and the corresponding native Android live-share walkthrough remain pending. They cannot exercise this candidate while production serves its prior server and web/native routes. The next step is a coordinated candidate server/web/Android deployment, then a fresh live share opened from its bare link after reviewer sign-in. No production success or native full-view success is claimed.
