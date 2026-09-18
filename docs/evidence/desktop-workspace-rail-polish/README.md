# Desktop Workspace rail polish — evidence

Both crops are the real Expo web build (`apps/mobile`, `expo start --web`) signed into an
isolated local `@beeline/server` through the authenticated phone API, at a 1280×800 viewport
with the Workspace switcher rail open and the current tile focused (so its descriptor card is
visible).

Reproduce:

```sh
createdb beeline_workspace_rail_polish
DATABASE_URL='postgresql://USER@localhost/beeline_workspace_rail_polish?host=%2Fvar%2Frun%2Fpostgresql' \
  MIGRATION_DATABASE_URL="$DATABASE_URL" NODE_ENV=development \
  node --import tsx apps/server/src/index.ts --migrate
# then run the server with PORT/PUBLIC_ORIGIN/BUZZY_AUTH_TENANTS_JSON/BUZZY_AUTH_OIDC_* set,
# exchange a dev session:    POST /v1/auth/github/exchange {"oidcToken":"local:<login>"}
# and seed the browser session stores: sessionStorage `buzzy.monolith.refresh.v1` (the raw
# refresh token) and `buzzy.monolith.identity.v1` (the identity id).
EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:<port> npx expo start --web
```

- `descriptor-before-1280x800.png` — before: the descriptor card's left edge lands on the
  rail's right edge (`left: 62` from a tile slot that starts 14 in; 14 + 62 = 76 = `RAIL_WIDTH`).
- `descriptor-after-1280x800.png` — after: one spacing step (`space.sm`, 8) of breathing room.
- `descriptor-gap-before-after-1280x800.png` — zoomed side-by-side; the red line is the rail's
  right edge at x=76.
- `workspace-attention-mark.png` — the `CommunitySwitcherTrigger` rendered in Chrome through
  `react-native-web` with `attention` on and off: the gray 7×7 square pinned to the Workspace
  mark's bottom-right corner is `workspaceAttentionMark`
  (`apps/mobile/sources/components/buzz/CommunityRail.tsx`), `groknight.selectedBorder`
  (`#83838d`), shown when a *different* Workspace has something needing the viewer.