# Store submission

Operator runbook for Google Play production and the App Store. Store publishing
uses `store_track=production` (or `beta` only by an explicit owner choice) in
`.github/workflows/unified-release.yml`.
Routine OTA releases keep `store_track=none` and do not build native binaries.
Every release that builds a new Android binary, including explicit native
recovery selection, publishes it to **production** with **completed** status
(full rollout after approval) and sends it for review automatically. Only an
explicit `store_track=beta` sends an Android build to Play beta instead; beta
also uses completed status and automatic review submission. iOS
`store_track=production` submits for App Review with automatic release after approval.

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
   app-level permissions on Beeline (`app.usebeeline`):
   *Release to production* (the default native release), *Release to testing
   tracks* (explicit beta releases), and *Manage store presence* (the explicitly
   authorized listing sync).

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

The **sideload** keystore for `npm run apk:release` lives in the
`ANDROID_SIDELOAD_*` repository secrets and the Trusty Squire vault (see
`apps/mobile/android-signing/README.md` for the 2026-10-15 rotation).
Rotating it requires existing sideload installs to be uninstalled and
reinstalled. Play builds never use it. The `store_android` job
runs `eas build --profile production --platform android`, whose AAB is signed by the
**EAS-managed upload key**, and Google Play App Signing owns the app signing key.
If the upload key is ever lost, Play's upload-key reset flow applies; the
sideload keystore is not involved either way.

### App link fingerprints for the `app.usebeeline` record

Both `assetlinks.json` copies (`web/.well-known/assetlinks.json`
and `apps/mobile/public/.well-known/assetlinks.json`) currently carry only the
sideload signing certificate. The Play App Signing certificate for the new
`app.usebeeline` record does not exist until the first AAB is uploaded, so its
SHA-256 fingerprint must be appended to the same `sha256_cert_fingerprints`
array afterwards — Play Console → Test and release → Setup → App signing → *App
signing key certificate*. Until that is done, verified `https://usebeeline.app`
links open in the browser for Play installs; sideload installs are unaffected.

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
PLAY_DRY_RUN=1 PACKAGE_NAME=app.usebeeline METADATA_DIR=apps/mobile/fastlane/metadata/android LANGUAGE=en-US \
  bash scripts/play-publish-listing.sh

# Production store publishing is requested through the audited dispatch_release
# tool under an owner/admin release command, with store_track=production.
# Keep the normal no-input release for OTA delivery.
```

## Recovering an already uploaded build

Merging this fix cannot change an existing Play upload. For the reported
versionCode **142**, firstmate must inspect its current release and publishing
state. The historical upload log already records it on production as completed
with
automatic review submission, before the later build-review regression. Verify
that current state rather than assuming promotion is needed. If it is no longer
on production with completed status, reuse that uploaded bundle in a production
release and start a full rollout. If it is already a completed production
release but is saved without review submission,
send **only that build** for review in Publishing overview. Preserve pending
listing edits unless the owner explicitly commands their publication. Do not
re-upload versionCode 142: Play version codes cannot be reused for a new upload.
Availability follows Google's review and any Console managed-publishing hold;
a successful upload alone does not make it downloadable. No Play state is
changed by this code change.

## What the store leg does

`store_track` accepts `none` (the OTA default), `production` (explicit
store submission), or `beta` (explicit owner choice for that release).
Production selects the native jobs for the affected
platforms. Explicit recovery selection (`all` or `mobile-native`) also builds
native binaries; every newly built Android binary publishes to production,
even with `store_track=none`; only an explicit `store_track=beta` changes
that destination. The iOS store upload requires an explicit store track; beta
stops at TestFlight and production also submits for App Review. Native job
failures fail the selected native component.

**`mobile_native_android`** (Play production): checks the app version
(`scripts/check-release-version.cjs`) and that the Play metadata is current, runs
`eas build --local --profile production-ci --platform android --non-interactive`,
produces the AAB locally, verifies package name, `versionName` and
`versionCode` with bundletool against the package version and the EAS build
record and rejects a debug signer, uploads the AAB as a run artifact, mints a
short-lived Play access token from the service account, then runs
`scripts/play-publish.sh` (create edit → upload bundle → `tracks.update` with
`track: production` by default (explicit beta override), `status: completed`, notes from
`fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` or `default.txt`
→ commit). Releases upload only the build to Play by default. Listing text and
images are never uploaded unless the release is explicitly dispatched with
`publish_listing=true` (default `false`) on an explicit workspace owner
command. The cited command must include a dedicated imperative line such as
"Publish the Play listing"; admin commands and routine release orders cannot
unlock listing uploads. The default path compares the committed listing with Play, discards the read edit, and logs that differences
were not uploaded; comparison errors only warn and do not fail the release.
The upload step records every locale's listing text and all eight Play image
types in the exact build edit before uploading. The **Enforce the Play listing
lock before committing the build** CD step re-reads that edit immediately before
commit and stops on any changed text/image, naming each locale and field/image
type. Failure to read or validate the edit/baseline also stops before commit.
Repo-vs-live differences alone remain advisory; the gate compares the edit
against its pre-upload state. Explicit owner listing consent unlocks this gate.

After the listing gate passes, the build edit commits normally, without
`changesNotSentForReview`, and is sent for review automatically. The commit
uses `changesInReviewBehavior=ERROR_IF_IN_REVIEW` to preserve an existing review.
A refused review submission fails the job; there is no fallback that saves an
unsent build and reports success. Play production uses `completed` status and
no `userFraction`, so approval enables full rollout rather than a staged rollout.
See Google's [commit parameters](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit)
and [release status](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks#Status).

The build commit never uploads listing metadata. When explicitly authorized,
`scripts/play-publish-listing.sh` separately reads the live listing and skips
unchanged text and image hashes. Changed listings clear and re-upload each
image type in filename order. `publish_listing` permits uploading changes;
it does not force re-uploading matching assets. That listing operation retains
its existing review behavior independently of the build commit.

**`mobile_native_ios`** (TestFlight): decodes the `.p8` secret to a
runner-temp file and points `EXPO_ASC_API_KEY_PATH` at it **before** the build
(eas-cli needs it to create or repair the App Store provisioning profile
non-interactively), runs `eas build --local --profile production-ci --platform
ios --non-interactive` on the `ios-builder` Mac runner. It inspects the IPA's
embedded bundle, package version, build number, runtime pin and photo purpose
string before `xcrun altool --upload-app`. The upload receipt's delivery UUID
must finish processing successfully and a new matching `VALID` build must
appear under app `6803948500` within 20 minutes. Apple processing errors,
including missing purpose strings (90683), fail the job even when altool
reported transport success. `ios-build.json` records the IPA identity,
delivery UUID and App Store build ID for the native checkpoint.
For `store_track=production`, initialization queries App Store Connect using the
existing ASC key before either native build starts. It starts from the mobile
package version at the release SHA. If that version is approved, in review,
waiting, live, or otherwise not editable, it selects the next patch above the
non-editable store versions (for example, `0.2.22` in
`PENDING_DEVELOPER_RELEASE` becomes `0.2.23`). An editable next patch can be
reused. The resolved version is applied automatically in both temporary build
checkouts: iOS `CFBundleShortVersionString` and Android `versionName` match,
without a human package edit or another workflow input. The committed package
version and runtime pins stay unchanged; explicit native recovery builds with
`store_track=none` use the package version.

After the verified upload, production uses `reviewSubmissions` to create or
reuse an editable App Store version, attach the verified build, set What's New
from `store/listing/en-US/release-notes.txt` on its existing localizations, and
submit for review with `releaseType=AFTER_APPROVAL`. Evidence includes the
version and submission IDs and confirmed review state. If the exact version
has already advanced beyond editing, the job records `version-already-submitted`
and its Apple state and succeeds. If an older review is still active, it
preserves that review, records `existing-review-active` with the active IDs and
states in `ios-build.json`, and succeeds after the upload; this outcome does
not claim the new build was submitted for review. Missing localizations,
unresolved export compliance, and Apple API failures still fail the job.

A manual unified release dispatch can resume the same identity after a cancelled
or terminated attempt, including migration failures and touched Fly Machines.
Those states suppress automatic self-redispatch only; no human cleanup is needed
to dispatch the identity again.

TestFlight groups and external-tester review remain separate operations. A missing distribution
certificate fails the build with one printed command, because eas-cli 22.2.0
never creates one non-interactively.

`scripts/play-promote-track.sh` remains available for explicitly commanded
recovery from beta to production. It enforces completed status and the same
listing lock and automatic review commit as a new build.

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
  `web/privacy/index.html` page.
- Enter the answers in `store/questionnaires/` into the current Play Console
  and App Store Connect forms, then re-check any changed form language.
- Confirm the PostHog build environment choice. The app sends no analytics
  without `EXPO_PUBLIC_POSTHOG_API_KEY`; when it is set, its lifecycle and OTA
  events must remain declared in the store answers.
- Confirm that Android FCM notifications and iOS notification capabilities are
  enabled for the submitted native binary.
