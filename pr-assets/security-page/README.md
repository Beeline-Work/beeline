# Security page visual evidence

These are full-page frames from the checked-in static files, captured with
`chrome-devtools-axi`. In each comparison, the new Security page is on the
left and the existing Privacy page is on the right.

- `security-privacy-desktop-comparison.png`: 1440 × 900 browser viewport
- `security-privacy-mobile-comparison.png`: 390 × 844 browser viewport

The mobile Security frame reported `innerWidth === scrollWidth === 390`, so
the page has no horizontal overflow at phone width.

## Claim sources

- Local harness homes, logins, and provider configuration:
  `apps/body/src/agent-home.ts`
- Server-stored Rooms, messages, corner facts, and grants:
  `apps/server/src/database.ts`
- Room/corner mount rules, credential masks, fallback behavior, and residual
  risk: `apps/body/src/bwrap-sandbox.ts`
- Exact-repository GitHub App token minting:
  `apps/auth/src/server-github-installation-routes.ts`
- Worktree-scoped credential helper and corner token environment:
  `apps/body/src/room-runtime.ts` and
  `apps/body/src/monolith-corner-turn.ts`
- Grant kinds and states: `packages/api-contract/src/agent-grants.ts`
- Requester-aware approval rules: `docs/approval-matrix.md`
- Revocation: `apps/server/src/phone-service.ts`
- Attachment and artifact expiry: `apps/server/src/media-ttl.ts`
- Account deletion and shared-message attribution:
  `apps/server/src/phone-service.ts` and
  `packages/api-contract/src/system-identity.ts`
- Public deletion language and the existing security contact:
  `relay-stack/web/privacy/index.html`

No `SECURITY.md` or dedicated security address exists in this repository, so
the page intentionally reuses the privacy contact, `dani@trustysquire.ai`.
