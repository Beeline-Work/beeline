# Profile component evidence

Captured from production profile components at 390px browser width with the standalone `apps/mobile/scripts/render-consolidated-board-proof.mjs` fixture. All identities, ownership, soul and work shown are illustrative fixtures, not live Workspace records. Transport and native adapters are shimmed; this is not native-device verification.

- `agent-dark.png`: owner profile, Settings bezel geometry, brass handle, model/difficulty, adjacent Message/Edit, SOUL, generation, permission and answer scope, recent work.
- `human-light.png`: human handle and role, higher-ranked Edit, Workspace connected agents, Ban.

Run with `CONSOLIDATED_PROOF_PORT=4181 node apps/mobile/scripts/render-consolidated-board-proof.mjs`; use `?view=profile` or `?view=human&theme=light`. Captured with Playwright's Chromium headless shell. `ProfileIdentity` imports `IDENTITY_SETTINGS_TILE` and `workspacePictureSeat`, the same geometry as Settings. Native navigation/scroll restoration and on-device appearance remain unverified.
