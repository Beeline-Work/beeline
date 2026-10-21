# Short schedule titles

Reproduction ebc844ec744260fdaf5b93010d0ffe549b6e30e1a33efbd47cd8b939ef54f162.

## Reproduced

On 2026-10-21, opened web.usebeeline.app → #beeline → Room actions →
Schedules and subscriptions in Squire's existing signed-in owner session.
Observed the six current schedules, including prompt fragments, cadence/place
subtitles, and “One-time 24-hour Play report access check…” labelled “Every day”.
The production database read confirmed that check has max_runs=1.

Before this change, title selection was in
apps/mobile/sources/buzz/scheduled-work.ts:56 (workflow display name or raw
prompt opening); subtitle construction was in
apps/mobile/sources/app/(app)/beeline/settings/schedules.tsx:109–113
(cadence, agent and place). The phone DTO omitted maxRuns.

The requested reviewer-bypass sign-in was attempted using the existing vault
reference. Squire load_saved refused its credential type with
unsupported_credential_type. The existing owner session provided live-screen
reproduction instead; reviewer-bypass authentication was not demonstrated.

## Demonstrated

The same reproduction uses the built screen and the six current schedule labels:
Morning card, Prompt replay, App speed test, Play downloads check, Feedback triage,
and Release. Recurring rows have no subtitle; the Play row says Once.
The workflow icon remains. A detail-page browser regression confirms Once · next,
while recurring details retain cadence, timezone and place.

- schedule-titles-dark.png and schedule-titles-light.png: actual screen bundled
  through the repository browser proof with phone DTO fixtures; both themes pass.
- android-local.png: that same built screen served locally and opened in Chrome
  on a Beeline-leased Android 35 emulator. This is an Android browser stand-in,
  not a native installed-app or physical-phone proof.
- workflow-schedules.test.ts exercises daemon create, title-only update and phone
  reads against the database, including title validation and missing-title
  fallbacks. Its migration regression checks all six production IDs and preserves
  cadence, instructions and custom titles on repeated migration.

No release, restart, deployment or production database mutation was performed.
The backfill is included in the migration and takes effect when an authorized
release runs it. Live web and native-phone passing verification remains a
post-release step; the brief explicitly holds releases.

Run the rendered-path regression from apps/mobile:

    PROOF_SHOTS="$PWD/evidence/schedule-titles" npx vitest run 'sources/app/(app)/beeline/settings/schedules.browser.test.ts' -t 'owner schedules' --maxWorkers=1 --minWorkers=1
