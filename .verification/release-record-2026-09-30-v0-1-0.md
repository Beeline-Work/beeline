# Corner release record — 2026-09-30 v0.1.0 unified production dispatch

## Corner objective
Verify no run exists; dispatch main through unified workflow; confirm OTA
promotion and record; never change, push, merge code or submit stores.

## Human instruction (authority for this turn)
"Kick off a release - version code now 0.1.0" (posted twice, 2026-09-30
03:33 UTC, message ids 49036b39… and 4069530a…).

## Dispatch
- **Workflow run (attempt 1):** `36665502660`
  (<https://github.com/Beeline-Work/beeline/actions/runs/36665502660>)
- **Inputs:** `release_version=v0.1.0` only (selection auto, store_track none,
  no proof) · **head:** main @ `607809f9ca690a6b2073cdf870249afa39d9fb1c`
- **Duplicate check before dispatch:** no unified-release run in flight; the
  newest completed run was v0.0.134 (`36593389428`, success). One dispatch issued.
- **Planned components (initialize):** server, helper, mobile-ota, desktop,
  website selected; mobile-native carried; runtime pins unchanged
  (android 32 / ios 31); OTA-only, no store submission.

## Outcome — delivered, release record blocked
- **OTA (`mobile_ota`, attempt 1): SUCCESS — promoted to production.**
  `Checkpoint OTA promotion` passed; `mobile-ota-promoted-v0.1.0-607809f9…`
  artifact written. The durable `mobile-ota-delivery-index.json`
  (updatedAt 2026-09-30T04:05:59Z) records merge sha `607809f9…` as
  `state: published`, `publishedAt 2026-09-30T04:05:59.275Z`, across 15
  production update groups.
- **Server (attempt 1): SUCCESS** — deployed and the bounded exact server
  smoke check passed (the leg that killed the Sept 27 run).
- **Helper channel (attempt 2, run `36667893275`): SUCCESS** — CLI bundle
  published and the Pages release channel persisted (attempt 1's helper
  promotion had failed on a transient GitHub API 500 at
  `publishPagesChannel` upload; the retry succeeded).
- **Website / desktop / native:** website + desktop built and delivered;
  mobile-native carried (no native source changes).
- **Release record (GitHub Release + unified-release-index): BLOCKED.**
  The `release_result` job's "Create the one GitHub release record and
  preserve stable desktop downloads" step failed on attempts 2 and 3 with
  `desktop updater manifest did not converge`: the manifest committed to the
  release is never visible at
  `https://github.com/Beeline-Work/beeline/releases/latest/download/Beeline-latest.json`
  because the tag **`v0.1.0` already exists** — the human-authored
  "Buzzy v0.1.0 — MVP" release (2026-08-08, branch `fm/buzzy-release-apk`,
  asset `buzzy-v0.1.0.apk`). `gh release create v0.1.0` fails ("already
  exists"), the retry wrapper falls back to uploading onto the existing
  release, and that release is not "latest" (`v0.0.134` holds
  `isLatest=true`), so the convergence check against `releases/latest`
  keeps reading v0.0.134's manifest and can never match the new one.
- **Attempts:** `36665502660` (attempt 1, failure component:helper),
  `36667893275` (attempt 2, helper promoted then record step failed),
  `36668462000` (attempt 3, auto-redispatch, record step failed again).
  Identity `v0.1.0-607809f9…` is **not terminated** (no cancellation, no
  migration failure, no Fly machine touched by a retry — server skipped on
  retries). All components are at `checked`/`carried` in the attempt state;
  only the durable record + index are unpublished.

## Open decision for the human (lunchboxfortwo)
The requested version collides with the existing Buzzy v0.1.0 release tag.
Two ways to finish:
1. **Complete under v0.1.0** — mark the existing `v0.1.0` release as the
   repo's latest (its desktop assets are the freshly built, signed v0.1.0
   installers; desktop updaters then serve the v0.1.0 manifest), then
   re-dispatch the same identity (attempt 4) so the record step converges
   and the unified-release-index publishes.
2. **Ship v0.0.135 instead** — routine dispatch with no version input plans
   the next increment from the last successful index (v0.0.134) and produces
   a clean fresh-tag release; the already-promoted v0.1.0 OTA would be
   superseded by the new version's groups.

This record is written locally only; per the corner objective it was not
committed, pushed, or PR'd.
