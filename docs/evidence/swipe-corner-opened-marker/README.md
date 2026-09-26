# Swipe-to-corner "corner opened" marker — real-app evidence

Frames from the real Expo web client against a local `@beeline/server` on a
disposable PostgreSQL database, signed in as the development-only
`local:markerproof` identity in its own `#welcome` Room. No production account
or Workspace was touched.

## Frames

- `01-room-before-390x844.png` — the Room before the second swipe (one earlier
  corner, `spare amber corner`, already marked under the release-notes message).
- `02-swipe-sheet-390x844.png` — a right swipe on "We should also check the
  sign-in retry path…" raises the existing forward sheet.
- `03-corner-opened-390x844.png` — `Open a new corner` lands in the new
  `calm willow corner` with the forward staged in its composer.
- `04-room-marker-390x844.png` — back in the Room, the drop-down mark,
  `Corner opened · calm willow corner` and `Open →` sit directly beneath the
  source message; the newer corner is anchored under the OLDER message rather
  than at the transcript tail.
- `05-open-lands-in-corner-390x844.png` — tapping that line opens
  `calm willow corner`.
- `06-after-reload-390x844.png` — after a full page reload both markers are read
  back from the server under their source messages.
- `07-marker-closeup-3x.png` — the same two lines at 3× device scale, showing
  the new `CornerBranchGlyph`.
- `08-desktop-marker-1180x900.png` / `09-desktop-open-work-pane-1180x900.png` —
  desktop layout: the same markers, and `Open →` opening the corner in the work
  pane.

## Capture recipe

1. `docker run postgres:16`, then `MIGRATION_DATABASE_URL=… node --import tsx
   src/index.ts --migrate` in `apps/server`.
2. Start the server on `127.0.0.1:19191` with `NODE_ENV=development`, a
   `BUZZY_AUTH_TENANTS_JSON` tenant for that host, placeholder
   `BUZZY_AUTH_OIDC_*` values, and
   `BEELINE_WEB_APP_ORIGINS=http://127.0.0.1:19106`.
3. `POST /v1/auth/github/exchange {"oidcToken":"local:markerproof"}`, write the
   returned refresh token and identity id into `sessionStorage`
   (`buzzy.monolith.refresh.v1`, `buzzy.monolith.identity.v1`), and seed four
   messages with `sendRoomMessage`.
4. `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:19191 npx expo start --web
   --port 19106`.
5. `chrome-devtools-axi` session `corner-marker`; the swipe is a real pointer
   drag (pointerdown → 20 pointermoves → pointerup) on the message text.
