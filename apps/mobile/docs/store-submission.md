# Native store beta submission

This is the operator runbook for submitting review drafts after the monolith
cutover. It does not authorize a public release.

The Google Play developer account is active under Moon Rice Limited
(`dani@trustysquire.ai`). Keep that account and its service-account material
outside this repository.

## Owner-supplied secrets

1. `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` — an absolute path to the Play service
   account JSON key that the owner will mint in the Moon Rice Limited Play
   Console. It is intentionally a path in `eas.json`, never a checked-in key.
2. `EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID`, and `EXPO_ASC_ISSUER_ID` — the
   existing App Store Connect API key path, key ID, and issuer ID. The key file
   remains outside this repository.

The runner also needs its normal `EXPO_TOKEN`. Do not add any of these values
to an `.env` file, a build profile, a commit, or a pull-request log.

## One-command beta submission

After the monolith cutover is landed and the owner has approved the listing and
privacy answers, run from `apps/mobile`:

```sh
npm run release:build:stores:beta
```

This creates store-distribution builds for both platforms and hands them to the
`beta` EAS Submit profile. Android is uploaded to the Google Play `beta` track
with `releaseStatus: draft`; iOS is uploaded to TestFlight. The same native
build profile can be sent to the private Play `internal` track with:

```sh
eas submit --platform android --profile production --latest --non-interactive
```

Neither command publishes an App Store or Google Play production listing.
Sending a Play draft for review, promoting a Play track, and adding external
TestFlight testers remain deliberate console actions by the owner.

## Required human checks before the first upload

- Approve the listing copy and `store/assets/` output in this repository.
- Deploy and open `https://usebeeline.app/privacy` from the tracked
  `relay-stack/web/privacy/index.html` page.
- Enter the answers in `store/questionnaires/` into the current Play Console
  and App Store Connect forms, then re-check any changed form language.
- Confirm the PostHog build environment choice. The app sends no analytics
  without `EXPO_PUBLIC_POSTHOG_API_KEY`; when it is set, its lifecycle and OTA
  events must remain declared in the store answers.
- Confirm that Android FCM notifications and iOS notification capabilities are
  enabled for the submitted native binary.
