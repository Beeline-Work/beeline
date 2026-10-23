# Thinking status transcript margins

## Requested main versus PR captures

The additional `main-360/` and `pr-360/` evidence rebuilds the entire mobile app from detached main (`9054174165545880fb70a1fd40c472ae997fd13f`) and the PR source (`13a90715b488dea74d8834720e8dcd9fec55b196`), at phone width 360 and desktop width 1280, in both themes. Main is checked out separately under `.scratch/thinking-main`; installed dependencies and unchanged workspace dist outputs are reused. The app source is not substituted or mocked. The four `*-360-comparison.png` files show main on the left and PR on the right.

The existing PR #2847 kit supplies `seed-beeline.mjs` (called by our local seed), `serve.mjs` (unchanged), the Chrome CDP capture client, and the actual `ink.py` pixel-measurement function (imported by our measurement wrapper). Its Room-list capture selectors are adapted to the transcript in `kit/capture.mjs`. The wrapper records both edges of message ink and its column, agent name ink, and STOP ink in `measurements.json`. Production sign-in is not needed for any of this proof.

Run `capture.mjs main-360` or `capture.mjs pr-360` while serving the corresponding exported build on 18892, then `python3 -I kit/measure.py` and `python3 -I kit/compose.py main-360 pr-360`. The default phone width is now 360; earlier 412-wide captures remain below as additional evidence.

| Build / surface / theme | Text ink left–right | Text column left–right | Name ink left–right | STOP ink left–right |
| --- | --- | --- | --- | --- |
| main-360 / desktop-dark | 357.0–745.5 | 356–1264 | 391.0–491.0 | 1211.5–1254.0 |
| main-360 / desktop-light | 357.0–745.5 | 356–1264 | 391.0–491.0 | 1211.5–1254.0 |
| main-360 / phone-dark | 16.5–320.5 | 16–344 | 35.0–135.0 | 307.5–350.0 |
| main-360 / phone-light | 16.5–320.5 | 16–344 | 35.0–135.0 | 307.5–350.0 |
| pr-360 / desktop-dark | 357.0–745.5 | 356–1264 | 357.0–457.0 | 1221.5–1264.0 |
| pr-360 / desktop-light | 357.0–745.5 | 356–1264 | 357.0–457.0 | 1221.5–1264.0 |
| pr-360 / phone-dark | 16.5–320.5 | 16–344 | 17.0–117.0 | 301.5–344.0 |
| pr-360 / phone-light | 16.5–320.5 | 16–344 | 17.0–117.0 | 301.5–344.0 |



Reproduction THINKING-MARGINS-1: open Ruby's DM with a working turn, then compare the thinking name and STOP with the transcript column. Repeat at phone (412 × 892) and desktop (1280 × 860), in Bone and Obsidian.

This uses the real Expo web export and local monolith, a disposable PostgreSQL container on loopback port 5557, and the CDP/server/seed/ink approach from PR #2847. No production data or sign-in credentials are used. `before/` restores the pre-fix TurnProgressLine from the parent of d4463c39a; `after/` uses the final component and desktop caller. Full screenshots and DOM rectangles are checked in. The four comparison images crop the transcript and composer, with red rules at the transcript column bounds.

## Measured result

CSS pixels, measured from rendered pixels at DPR 2. Positive name delta means indented from the message's first visible glyph. STOP delta compares its last visible pixel with the transcript column's right boundary; the sample message is shorter than the column, so its actual last glyph is also recorded separately in measurements.json.

| Surface (both themes) | Before name delta | After name delta | Before STOP delta | After STOP delta |
| --- | ---: | ---: | ---: | ---: |
| Phone DM | 18.5 | 0.5 | +6 | 0 |
| Desktop DM | 34 | 0 | -10 | 0 |

The same locally built app is also captured in the Room and corner routes (`after-room/`, `after-corner/`). The current desktop router explicitly opens corners in the primary view (`openDesktopCorner`), so it does not expose the legacy inspector cockpit on this user path. That component still receives the inset fix and its component tests pass. `kit/measure.py` fails if any after capture exceeds the one-point tolerance.

The faint leading mark is the animated BeelineMarkSpinner. It now lives after the counter, inside the row. It remains visible and is never clipped. Desktop callers already provide the transcript inset and disable the row's additional inset. STOP's trailing letter spacing is compensated geometrically so its visible ink, not its unused tracking, ends on the column boundary. Wording, font, timer, colour, vertical layout, STOP callback, transcript and composer are unchanged.

## Re-run

Read the kit files before running. Use an isolated local server/database as described in `../room-list-icon-centre/README.md`, with server port 18890 and web origin http://127.0.0.1:18892. Set LATENCY_RIG_DATABASE_URL to your disposable loopback latency_rig database; the seed rejects other hosts/databases. Configure the server's local-only review secret to `thinking-local-disposable-review`.

1. `node kit/seed.mjs` creates the small Beeline fixture using the existing kit and adds working turns.
2. Export the old and final component with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:18890 npx expo export --platform web --output-dir <build>` from apps/mobile. Restore final source immediately after the baseline export.
3. Serve one build at a time: `node ../room-list-icon-centre/kit/serve.mjs <build> 18892`.
4. From the repository root, run `node apps/mobile/evidence/thinking-margins/kit/capture.mjs before` or `after`. Optional fourth argument `room` or `corner` selects the other transcript routes (third argument is port 18892). Use a unique CDP_PROFILE per concurrent capture.
5. `python3 -I kit/measure.py` and `python3 -I kit/compose.py` measure and produce comparisons.

The production web.usebeeline.app check remains pending sign-in handback. The existing live browser card is left open. These captures prove the local built app; they do not claim a production deploy or production sign-in.
