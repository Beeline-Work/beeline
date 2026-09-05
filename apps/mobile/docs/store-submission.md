# Store beta submission

Operator runbook for the Google Play private beta and TestFlight. Store uploads
are the `store_track` input of the one release workflow
(`.github/workflows/unified-release.yml`), so a store binary always comes from a
released SHA. Nothing here publishes a public listing or a production release on
its own: the AAB lands as a *draft* release on the track you named, and the
final press stays in Play Console / App Store Connect.

The Google Play developer account is Moon Rice Limited. Keep that account, its
service account key and the App Store Connect API key outside this repository.

## Inputs the owner supplies once

### Google Play

1. **Repository secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`** — the full JSON key of
   a Google Cloud service account (IAM → Service accounts → Keys → JSON). Paste
   the file's contents as the secret value. Every Play workflow reads only this
   secret and stops with one plain line when it is missing. The workflows mint
   the access token themselves with the self-signed JWT flow
   (`scripts/play-token.mjs`, node only): the key's private key signs a JWT that
   `oauth2.googleapis.com/token` exchanges for a token. The IAM Service Account
   Credentials API (`iamcredentials.googleapis.com`, which
   `google-github-actions/auth` requires) is not enabled in the project and is
   not needed; only the Google Play Android Developer API must be enabled.
2. **Play Console invite for that service account** — Play Console → Users and
   permissions → Invite new users → the service account's email address, with
   app-level permissions on Beeline (`app.usebeeline.mobile`):
   *Release to testing tracks* (the release's store leg) and *Manage store
   presence* (its listing sync). Promoting to production later also needs
   *Release to production*.

   The Google Play Android Developer API must be enabled on the service
   account's Cloud project.

### TestFlight

3. **Repository secrets `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`,
   `EXPO_ASC_API_KEY_P8`** — an App Store Connect API key with the *App Manager*
   role: the key id, the issuer id, and the `.p8` file encoded with
   `base64 -w0 AuthKey_<id>.p8`. The `store_ios` job writes the decoded key to a
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

The **sideload** keystore for `npm run apk:release` lives only in the
`ANDROID_SIDELOAD_*` repository secrets (see
`apps/mobile/android-signing/README.md`) — never rotate it, since that would
break in-place upgrades for existing sideload installs. Play builds never use
it. The `store_android` job
runs `eas build --profile production --platform android`, whose AAB is signed by the
**EAS-managed upload key**, and Google Play App Signing owns the app signing key.
If the upload key is ever lost, Play's upload-key reset flow applies; the
sideload keystore is not involved either way.

## Runtime compatibility stamp

A store binary carries the same `runtimeVersion` as the OTA updates it may
later receive, and that value is pinned by hand in `app.config.js`. A store
release therefore ships whatever pin is on the release commit; it needs no
action here.

What does need action is a native change (dependency, config plugin,
permission). The `NATIVE FINGERPRINT` gate fails that PR until the pin is
bumped, and a bumped pin means the phones on the old pin can only cross over by
installing a new binary — so the bump has to be followed by a store submission
(and, for the OTA canary, one `eas build --profile beta-apk`). Check the stamp
with

```sh
cd apps/mobile && npm run fingerprint:check
```

## Commands

```sh
# Regenerate the derived Play metadata after editing apps/mobile/store/
node scripts/sync-play-metadata.mjs
node scripts/sync-play-metadata.mjs --check     # what the release's store leg runs first

# Prove the Play API scripts without a service account
npm run test:play
PLAY_DRY_RUN=1 PACKAGE_NAME=app.usebeeline.mobile METADATA_DIR=apps/mobile/fastlane/metadata/android LANGUAGE=en-US \
  bash scripts/play-publish-listing.sh

# Release AND upload to the stores: one button, one release SHA.
# The captain cuts the release; store_track adds the store leg to it.
gh workflow run unified-release.yml -f store_track=internal
gh workflow run unified-release.yml -f store_track=beta

# Move an already-uploaded release between Play tracks (operator-run script;
# the release leg only ever writes a draft to the track it was given).
# play-token.mjs prints `access_token=<token>` on stdout when GITHUB_OUTPUT is unset.
export GOOGLE_PLAY_SERVICE_ACCOUNT_JSON="$(cat service-account.json)"
ACCESS_TOKEN="$(node scripts/play-token.mjs | sed 's/^access_token=//')" \
PACKAGE_NAME=app.usebeeline.mobile FROM_TRACK=internal TO_TRACK=beta RELEASE_STATUS=draft \
  bash scripts/play-promote-track.sh
```

## What the store leg does

`store_track` (`none` by default, else `internal` | `beta` | `production`) adds
two jobs to the release, both starting after `confirm_app` and both checking out
the exact release SHA. Neither is a dependency of the delivery report, so a store
failure fails only its own job: the OTA delivery report stays the authority on
whether the release was delivered, and each job's step summary carries the Play
Console / App Store Connect links.

**`store_android`** (Play *`store_track`* track): checks the app version
(`scripts/check-release-version.cjs`) and that the Play metadata is current, runs
`eas build --profile production --platform android --non-interactive --wait
--json`, downloads the AAB, verifies package name, `versionName` and
`versionCode` with bundletool against the package version and the EAS build
record and rejects a debug signer, uploads the AAB as a run artifact, mints a
short-lived Play access token from the service account, then runs
`scripts/play-publish.sh` (create edit → upload bundle → `tracks.update` with
`releaseStatus: draft`, notes from
`fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` or `default.txt`
→ commit) and `scripts/play-publish-listing.sh` (one edit carrying title, short
and full description, icon, feature graphic and phone screenshots, each image
type cleared then re-uploaded in filename order, validated and committed).
The release always lands as *Ready to publish*; you press Release in Play
Console.

**`store_ios`** (TestFlight): version check, decodes the `.p8` secret to a
runner-temp file and points `EXPO_ASC_API_KEY_PATH` at it **before** the build
(eas-cli needs it to create or repair the App Store provisioning profile
non-interactively), runs `eas build --profile production-ci --platform ios
--non-interactive --wait --json`, refuses a build whose app version differs from
the package version, then `eas submit --platform ios --profile production --id
<build> --non-interactive --wait`. TestFlight processing, tester groups and any
external-tester review stay in App Store Connect. A missing distribution
certificate fails the build with one printed command, because eas-cli 22.2.0
never creates one non-interactively.

`scripts/play-promote-track.sh` moves the newest release on one track onto
another (it takes the highest `versionCode` with its name and notes, in one
validated and committed edit). A track's first roll-out starts Google's review,
so that stays a deliberate operator step rather than part of a release.

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
