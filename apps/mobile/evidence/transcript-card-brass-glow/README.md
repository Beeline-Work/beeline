# Transcript brass-glow evidence

Captured from the real Expo Android app and desktop web app against an isolated
local `@beeline/server` and local Postgres. The stack follows the committed
`docs/evidence/desktop-workspace-nav` and `apps/mobile/evidence/corner-states-four`
recipes: migrated server schema, seeded `local:captain`, Hoots, and Sol
identities, authenticated phone API reads, and database-backed GitHub event
cards. No fixture renderer was used.

Each four-frame strip is ordered left to right: the first fully painted frame
(`0 ms`), then `300 ms`, `900 ms`, and `1800 ms`. Android frames were extracted
at those offsets from one uninterrupted `adb screenrecord`; desktop frames
freeze the real rendered DOM at the corresponding sampling instant before the
Chrome screenshot is taken.

## Demonstrated

- [`android-brass-glow.gif`](./android-brass-glow.gif) is the continuous
  Android emulator capture: a live card arrives, a second PR row grows into the
  existing fold, and the first row flips from opened to merged.
- [`android-card-strip.png`](./android-card-strip.png),
  [`android-row-strip.png`](./android-row-strip.png), and
  [`android-label-strip.png`](./android-label-strip.png) isolate those three
  Android transitions. The card strip's first panel shows the physical nested
  brass halo and brass title; both are gone in its fourth panel.
- [`desktop-card-strip.png`](./desktop-card-strip.png),
  [`desktop-row-strip.png`](./desktop-row-strip.png), and
  [`desktop-label-strip.png`](./desktop-label-strip.png) show the same sequence
  in Chrome at exactly 1440×900.
- [`android-scroll-stability.png`](./android-scroll-stability.png) shows the
  same history lines at the same coordinates before and after a live folded-row
  append. [`desktop-scroll-stability.png`](./desktop-scroll-stability.png)
  shows the equivalent desktop check; measured `scrollTop` remained 200 while
  `scrollHeight` grew from 1231 to 1294.
- [`android-reduced-motion.png`](./android-reduced-motion.png) was captured
  with all three Android animation scales set to zero. The newly delivered card
  rendered directly in its settled frame and colors.
- [`desktop-reduced-motion.png`](./desktop-reduced-motion.png) was captured
  with the browser `prefers-reduced-motion` media query emulated as `reduce`;
  the new card likewise rendered settled immediately.

The normal-motion captures show only opacity, color, halo, and the row's height
changing—there is no translation, scale, rise, slide, or pulse.
