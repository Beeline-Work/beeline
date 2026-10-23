# Thinking status transcript margins

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
