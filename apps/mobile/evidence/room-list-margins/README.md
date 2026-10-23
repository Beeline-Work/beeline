# Room list margins: 20 px on phone and desktop

Reproduction RLM-1: open the Room list in the built web app on a 412 px phone
viewport and in the 340 px desktop sidebar (1280 px window), in Bone and
Obsidian, and measure the ink edges the approved mock names.

## How it was run

- Server: the current monolith (`apps/server/src/index.ts`) against a disposable
  pgvector PostgreSQL 16 container on `127.0.0.1:5544`, migrated, then seeded with
  `scripts/latency-rig/seed-local.mjs` and `kit/seed-beeline.mjs` (a "Beeline"
  workspace with #beeline, #markets, #design and DMs with Ruby and Speedy;
  #beeline and @speedy unread). Environment as in `scripts/latency-rig/run-local.sh`,
  with `PORT=8790` and `BEELINE_WEB_APP_ORIGINS=http://127.0.0.1:8792`.
- App: `npx expo export --platform web` of `main` (before) and of this branch
  (after), both built with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:8790`
  into `/tmp/rlm88/web-before` and `/tmp/rlm88/web-after`.
- Capture: `kit/run.sh before|after` serves one build, signs in through the
  local review link, and screenshots at device scale 2 (`kit/capture.mjs`).
  Desktop opens #beeline so its row is selected. `kit/swipe.mjs` swipes the
  #markets card to reveal Leave.
- Measure: `python3 -I kit/ink.py before after` finds the first and last
  non-background pixel inside each control's DOM box. Phone edges are measured
  from the screen; desktop edges from the sidebar's inner edge (its divider
  line), as in the mock.

## Results (`ink.json`, CSS px, same in Bone and Obsidian)

| Edge | Phone before | Phone after | Desktop before | Desktop after |
| --- | --- | --- | --- | --- |
| Workspace avatar left | 24 | 20 | 16 | 20 |
| Tray ink right | 30.5 | 19.5 | 30.5 | 19.5 |
| All filter left | 16 | 20 | 19.5 | 20 |
| Search ink right | 29.5 | 20 | 21.5 | 20 |
| ROOMS / DIRECT MESSAGES label left | 16.5 | 20.5 | 16.5 | 20.5 |
| + ink right | 29.5 | 19.5 | 19.5 | 19.5 |
| Room card edges | 16 / 16 | 20 / 20 | | |
| Room name left (selected row too) | | | 24.5–25.5 | 20.5 (21 for "@") |
| Unread dot right | | | 19 | 20 |

Text boxes start exactly on 20; the half point on labels and names is the
glyph's own side bearing ("@" has one point). The swipe Leave tile ends on
the card's 20 px edge (`swipe-before-after.png`).
