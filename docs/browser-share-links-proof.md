# Shared browser link proof

Reproduction 2026-10-20: opening the production bare share link returned HTTP 403 with zero bytes. Repeated here with curl before implementation. Production's new `/beeline/browser-share` route also shows “Unmatched Route” before deployment.

The candidate adds a public entry page with fixed Beeline web and native destinations. It does not query or disclose the session's Room. Phone authentication, current membership and agent access policy still control capability issuance and viewing. The share tool returns the actual card message id and an instruction to open the card posted in this place, with no URL; the internal share URL stays on the card for authenticated streaming.

## Built service stand-in

Run `npm run build` then `node --import tsx scripts/prove-browser-share-link.ts`.

This runs built server modules against isolated PGlite through the mounted HTTP server. The GitHub assertion exchange uses an isolated fixture verifier, not a production login. Under Reproduction 2026-10-20 the same bare-link path now returns 200 with 494 bytes and both Beeline destinations. An unauthenticated phone open returns 401; fixture sign-in followed by `openComputerSession` returns a capability; the viewer returns 200. Revoking Room membership makes the issued capability return 403 with an explanation. Ending the share returns 410 with an explanation.

## App checks

- Server handoff suite: 22 tests pass, including missing/invalid/expired tokens, revoked membership, valid viewer HTML and ended shares.
- Body share/tool suites: 38 tests pass; returned card id and open-card instruction are checked; the result contains no URL.
- API contract suite: 477 tests pass.
- Mobile route, existing viewer, native link delivery and pending-sign-in tests pass.
- Root typecheck, UI policy and workflow path checks pass.
- Web export and Android Hermes export succeed. The exported candidate renders its invalid-link explanation in a desktop browser and Android Chrome on an isolated API 36 emulator. This checks the browser route, not native app takeover or sign-in.

## Post-release acceptance

Ruby directed normal review and merge using the built HTTP/socket proof as pre-merge evidence, without a separate candidate deployment. After the next release reaches production, Ruby will order the signed-in walkthrough on `web.usebeeline.app` and the corresponding native Android live-share walkthrough. Those live checks remain pending; no production success or native full-view success is claimed.

## Missing DM card: SHARE-CARD-DM-1

Read-only production metadata confirms share `x2DgjDTMYApB_MhVPJBG3tnvFhxlPutBpd5zCXwwwmQ` has a committed, undeleted `computer-session` message in the requested DM. The historical tool mislabeled the share id as `cardId`; the actual message id is a separate 64-character id. Its URL/title/status satisfy the client card schema, and imported-history filtering does not apply to this DM.

The publishing service emitted a targetless `message` invalidation. The mounted socket server needs `messageId` to project a committed `message-delta`; without it, direct card delivery is absent and recovery depends on a covering read or PostgreSQL notification. The fix names the committed message after its transaction completes.

The new mounted-DM socket regression failed before this fix: the owner received no `message-delta`, despite the card being persisted. It now receives the card, the actual message id matches the tool result, the production client parser retains `computerSession`, a later Room read agrees, and a non-member receives no card. No LISTEN bridge or reload is used. A mobile regression parses and folds the same DTO shape and renders the live card/open control without needing an agent-turn request id. The built proof script also exercises that existing-socket DM delivery path before opening the share URL.

This establishes and fixes a direct delivery defect. The original owner's visible symptom still needs confirmation against the deployed candidate; no historical client trace proves which recovery path failed on that phone.
