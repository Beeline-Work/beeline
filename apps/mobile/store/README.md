# Beeline store listing package

This directory is the reviewable source package for the native-store listing.
It makes no store API calls. The current app identity is `app.usebeeline`.

## Files to upload

- `listing/en-US/title.txt` — Google Play app name (30-character limit).
- `listing/en-US/short-description.txt` — Google Play short description (80-character limit).
- `listing/en-US/full-description.txt` — Google Play full description and App Store description source.
- `listing/en-US/release-notes.txt` — Play "What's new" for a release (500-character limit).
- `assets/store-icon-512.png` — Google Play app icon; 512 × 512 32-bit PNG (brass loop).
- `assets/ios-app-icon-1024.png` — App Store icon source; 1024 × 1024 PNG.
- `assets/feature-graphic-1024x500.png` — Google Play feature graphic; 1024 × 500 24-bit PNG, no alpha.
- `screenshots/` — four 1080 × 2090 framed captures of the Beeline app, in carousel order.

The icon, feature graphic and screenshots are owner-delivered finals; there is
no generator for them any more. Replace a file in place and keep the listed
dimensions and PNG formats — `scripts/sync-play-metadata.mjs` refuses anything
Play would reject.

## Derived Play metadata

`apps/mobile/fastlane/metadata/android/en-US/` is generated from this package
by `node scripts/sync-play-metadata.mjs` (run from the repository root) and
committed; the Play workflows read that directory, never this one. Regenerate
after any edit here; `--check` reports drift and `npm run test:play` covers it.

## Submission gate

See `docs/store-submission.md` for the owner-supplied secrets, the
`gh workflow run` commands for Play and TestFlight, and the required human
review gates. Play releases default to `draft`, so nothing reaches testers
without a press in Play Console unless `release_status=completed` is chosen.
