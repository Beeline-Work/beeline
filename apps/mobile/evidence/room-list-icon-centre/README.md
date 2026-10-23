# Room list icons: one centre line (option A)

Reproduction RLIC-1: open the Room list in the built web app on a 412 px phone
viewport and in the 340 px desktop sidebar (1280 px window), in Bone and
Obsidian, and measure the ink of the tray, search and Rooms / Direct messages +
marks against the right edge.

## How it was run

- Server: the current monolith (`apps/server/src/index.ts`) against a disposable
  pgvector PostgreSQL 16 container on `127.0.0.1:5546`, migrated and seeded as in
  `../room-list-margins/README.md` (`scripts/latency-rig/seed-local.mjs`, then
  `kit/seed-beeline.mjs` before each capture). `PORT=8790`,
  `BEELINE_WEB_APP_ORIGINS=http://127.0.0.1:8792`.
- App: `npx expo export --platform web` of `main` (before) and of this branch
  (after), built with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:8790`
  into `/tmp/rlic/web-before` and `/tmp/rlic/web-after`.
- Capture: `kit/run.sh before|after` serves one build, signs in through the
  local review link and screenshots at device scale 2 (`full/`).
- Measure: `python3 -I kit/ink.py before after` finds the first and last
  non-background pixel inside each control's DOM box (`ink.json`). Distances
  are from the screen edge (phone) or the sidebar's inner edge (desktop), in
  CSS px; one device pixel is 0.5 px.
- `python3 -I kit/compose.py /tmp/rlic/shots .` writes the zoomed crops: grey
  line = 20 px edge, dark line = search ink centre.

## Results (CSS px from the right edge; same on phone and desktop, Bone and Obsidian)

| Mark | Before: centre | Before: ink end | After: centre | After: ink end |
| --- | --- | --- | --- | --- |
| Tray | 27.0 | 19.5 | 29.0 | 21.5 |
| Search | 28.75 | 20.0 | 28.75 | 20.0 |
| Rooms + / Direct messages + | 28.0 | 19.5 | 29.0 | 20.5 |

Before, the centres spread 1.75 px. After, they agree within 0.25 px, the
search ink still ends on 20 and no mark's ink is closer than 20 to the edge.
The code target (`groknight.ts`) is 28.65 from Ionicons' search-outline outline
(ink 44 to 466 of 512 units at 21 px); the captures round it to the 0.5 px
device grid. Left edges, cards and rows are unchanged (`ink.json`).
