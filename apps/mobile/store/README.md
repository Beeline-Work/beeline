# Beeline store listing package

This directory is the reviewable source package for the native-store listing.
It makes no store API calls. The current app identity is `app.usebeeline.mobile`.

## Files to upload

- `listing/en-US/short-description.txt` — Google Play short description (80-character limit).
- `listing/en-US/full-description.txt` — Google Play full description and App Store description source.
- `assets/store-icon-512.png` — Google Play app icon; 512 × 512 PNG.
- `assets/ios-app-icon-1024.png` — App Store icon source; 1024 × 1024 PNG.
- `assets/feature-graphic-1024x500.png` — Google Play feature graphic; 1024 × 500 PNG.
- `screenshots/` — four 1080 × 2400 Android captures, each from the Beeline app.

The store derivatives retain the canonical continuous-loop geometry from
`apps/mobile/sources/assets/images/icon.svg`. Their brass loop is the
owner-approved store treatment; it is deliberately scoped to this package and
does not change the app's existing brass-on-aubergine icon sources.

## Regenerating the graphics

Run `bash store/assets/generate.sh` from `apps/mobile`. The script reads only
the tracked mobile icon and bundled font, then emits deterministic PNGs (no
dates or metadata). It preserves the canonical mobile icon geometry and applies
the owner-approved brass color only to its store-only raster derivative.

## Screenshot provenance

The four screenshots are unscaled API 36 Android captures curated from
`apps/mobile/evidence/monochrome-overhaul/after/`. Replace them after the
monolith cutover only when the reviewed screen state materially changes; retain
the 9:20 portrait ratio required by both stores.

## Submission gate

See `docs/store-submission.md` for the two owner-supplied secrets, exact
one-command beta release, and the required human review gates. `eas.json`
submits Android releases as `draft`, so neither its `internal` nor `beta` track
can be made public by this configuration.
