# Store beta submission

Operator runbook for the Google Play private beta and TestFlight. Every store
action is a manually dispatched GitHub workflow; nothing here publishes a public
listing or a production release on its own.

The Google Play developer account is Moon Rice Limited. Keep that account, its
service account key and the App Store Connect API key outside this repository.

## Inputs the owner supplies once

### Google Play

1. **Repository secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`** — the full JSON key of
   a Google Cloud service account (IAM → Service accounts → Keys → JSON). Paste
   the file's contents as the secret value. Every Play workflow reads only this
   secret and stops with one plain line when it is missing.
2. **Play Console invite for that service account** — Play Console → Users and
   permissions → Invite new users → the service account's email address, with
   app-level permissions on Beeline (`app.usebeeline.mobile`):
   *Release to testing tracks* (play-beta.yml, play-promote.yml) and
   *Manage store presence* (play-listing.yml). Promoting to production later
   also needs *Release to production*.

   The Google Play Android Developer API must be enabled on the service
   account's Cloud project.

### TestFlight

3. **Repository secrets `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`,
   `EXPO_ASC_API_KEY_P8`** — an App Store Connect API key with the *App Manager*
   role: the key id, the issuer id, and the `.p8` file encoded with
   `base64 -w0 AuthKey_<id>.p8`. testflight.yml writes the decoded key to a
   runner-temp file and points `EXPO_ASC_API_KEY_PATH` at it before the build
   (eas-cli needs it to create or repair the App Store provisioning profile
   non-interactively) and for the `production` submit profile in `eas.json`
   (team `89KT3SWYAF`, app `6803948500`).
4. **EAS-managed iOS signing** — run once from an operator machine:

   ```sh
   cd apps/mobile
   eas credentials --platform ios
   ```

   and let EAS create or upload the distribution certificate and App Store
   provisioning profile for `app.usebeeline.mobile` (Build Credentials →
   `production-ci` → Distribution Certificate). This step cannot be skipped:
   eas-cli 22.2.0 never validates or creates a distribution certificate in
   `--non-interactive` mode, with or without the API key, and a workflow run
   without one fails at the build step with `Credentials are not set up. Run
   this command again in interactive mode.` and prints this command. The
   `production-ci` build profile uses those remote credentials; the
   local-credentials `production` profile stays for operator-machine builds.

Both stores also need the existing `EXPO_TOKEN` repository secret.

## Signing choice: EAS credentials, never the sideload keystore

`apps/mobile/android-signing/release.keystore` is the committed **sideload**
keystore for `npm run apk:release`; its README says to rotate it before any
store distribution. Play builds therefore never use it. `play-beta.yml` runs
`eas build --profile production --platform android`, whose AAB is signed by the
**EAS-managed upload key**, and Google Play App Signing owns the app signing key.
If the upload key is ever lost, Play's upload-key reset flow applies; the
sideload keystore is not involved either way.

## Commands

```sh
# Regenerate the derived Play metadata after editing apps/mobile/store/
node scripts/sync-play-metadata.mjs
node scripts/sync-play-metadata.mjs --check     # what play-listing.yml runs first

# Prove the Play API scripts without a service account
npm run test:play
PLAY_DRY_RUN=1 PACKAGE_NAME=app.usebeeline.mobile METADATA_DIR=apps/mobile/fastlane/metadata/android LANGUAGE=en-US \
  bash scripts/play-publish-listing.sh

# Store listing (title, descriptions, icon, feature graphic, screenshots)
gh workflow run play-listing.yml

# Android beta: build on EAS, verify, publish to a Play track (draft by default)
gh workflow run play-beta.yml -f track=internal -f release_status=draft
gh workflow run play-beta.yml -f track=beta -f release_status=completed

# Move the newest release between Play tracks
gh workflow run play-promote.yml -f from_track=internal -f to_track=beta -f release_status=draft

# iOS: build on EAS with remote credentials, upload to TestFlight
gh workflow run testflight.yml
```

All four workflows are `workflow_dispatch` only; run them from `main`.

## What each workflow does

**play-beta.yml** (inputs `track` internal|alpha|beta, `release_status`
draft|completed): checks the release version (`scripts/check-release-version.cjs`)
and that the Play metadata is current, runs `eas build --profile production
--platform android --non-interactive --wait --json`, downloads the AAB from the
build's archive URL, verifies package name, `versionName` and `versionCode` with
bundletool against the package version and the EAS build record and rejects a
debug signer, uploads the AAB as a run artifact, mints a short-lived Play access
token from the service account, and runs `scripts/play-publish.sh`: create edit →
upload bundle → `tracks.update` (release name = app version, notes from
`fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` or
`default.txt`) → commit. `draft` leaves the release as *Ready to publish* in
Play Console; `completed` releases it to the track's testers immediately.
The run summary and log end with the Play Console link.

**play-listing.yml** (input `language`, default `en-US`): refuses a stale
metadata dir, then runs `scripts/play-publish-listing.sh`: one edit carrying
title, short and full description, icon, feature graphic and phone screenshots
(each image type cleared then re-uploaded in filename order), validated and
committed. Track releases are untouched.

**play-promote.yml** (inputs `from_track`, `to_track`, `release_status`):
`scripts/play-promote-track.sh` reads the source track, takes the release with
the highest `versionCode` with its name and notes, writes it to the destination
track with the requested status, validates and commits. A track's first
roll-out starts Google's review; `draft` keeps the final press in Play Console.

**testflight.yml** (no inputs): version check, `eas build --profile
production-ci --platform ios --non-interactive --wait --json`, refuses a build
whose app version differs from the package version, decodes the `.p8` secret to
a temp file, and runs `eas submit --platform ios --profile production --id
<build> --non-interactive --wait`. TestFlight processing, tester groups and any
external-tester review stay in App Store Connect.

Every Play script honours `PLAY_DRY_RUN=1`: it prints each API call (method,
URL, curl arguments, never the bearer token) and answers with a canned body, so
`npm run test:play` proves the sequences without credentials.

## Listing source and derived metadata

`apps/mobile/store/` is the human-reviewable package (copy under
`listing/en-US/`, graphics under `assets/`, `screenshots/`).
`apps/mobile/fastlane/metadata/android/en-US/` is derived from it by
`scripts/sync-play-metadata.mjs`, committed, and read verbatim by the Play
scripts. The sync validates every asset against the Play rules (512×512 32-bit
icon, 1024×500 24-bit feature graphic, 2–8 screenshots with sides between 320
and 3840 px and a long side at most twice the short side, text limits). The
App Store description uses the same full description; no App Store metadata
push exists yet, so listing text there is entered in App Store Connect by hand.

## Human checks before the first upload

- Approve the listing copy and `store/` graphics in this repository.
- Deploy and open `https://usebeeline.app/privacy` from the tracked
  `relay-stack/web/privacy/index.html` page.
- Enter the answers in `store/questionnaires/` into the current Play Console
  and App Store Connect forms, then re-check any changed form language.
- Confirm the PostHog build environment choice. The app sends no analytics
  without `EXPO_PUBLIC_POSTHOG_API_KEY`; when it is set, its lifecycle and OTA
  events must remain declared in the store answers.
- Confirm that Android FCM notifications and iOS notification capabilities are
  enabled for the submitted native binary.
