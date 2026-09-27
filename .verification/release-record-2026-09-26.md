# Corner release record — 2026-09-26 unified production dispatch

## Corner objective
Dispatch main through the unified production release workflow from this corner,
verify no duplicate attempt was in flight, then confirm OTA promotion and record
the outcome. Never change, push, or merge code; never submit stores.

## Dispatch
- **Workflow run:** `36249580309` (view: <https://github.com/Beeline-Work/beeline/actions/runs/36249580309>)
- **Event:** `workflow_dispatch` · **head:** `main` @ `7516b214c33e82767d5815606b53335a3ad856cd`
- **Dispatched:** 2026-09-26 14:45:22Z
- **Duplicate check before dispatch:** the only earlier unified-release run on this
  SHA had already completed; no attempt was in flight, so one dispatch was issued.

## Outcome
- **Workflow conclusion:** `failure`
- **OTA leg (`mobile_ota`):** **success — promoted.** The `Checkpoint OTA promotion`
  step completed; promotion checkpoint recorded. OTA update groups reached all
  configured production targets.
- **Native legs:** `mobile_native_ios` success, `mobile_native_android` success.
- **Desktop installers:** macOS-universal / windows-x86_64 / linux-x86_64 success.
- **Legs skipped:** server deploy plan + server (no server diff; release carried
  only the mobile components). `release_proof` skipped (no emulator device proof
  selected — OTA with no device proof is recorded UNPROVEN by release policy).
- **Failure leg:** `website` — `pages-leg` bundle failed to resolve two shared
  workspace-package build outputs:
  - `Could not resolve "@beeline/api-contract/agent-access"` (`./dist/agent-access.js` not found)
  - `Could not resolve "@beeline/nostr"` (`./dist/index.js` not found)
- **Final classify:** failure classified `component:website`; attempt record
  preserved under that failure class (release record for a failed attempt is
  preserved-and-classified, not published as a successful release).

## Facts recorded (and not)
- OTA was promoted to production in this attempt. ✅ (durable OTA delivery index)
- The unified release **record** for OTA delivery was **NOT** written as a
  successful release: the run's final checkpoint classified the attempt
  `component:website` and preserved the failure record instead. A later
  successful dispatch may publish a durable release record; that does not change
  this attempt's outcome.
- During this workflow attempt, this corner made no repository or store changes.
  Emulator device proof was not run (opt-in; skipped). This record was later
  committed and pushed as documentation in PR #1788 under a subsequent human
  instruction; that publication did not change the release attempt.

## Google Workspace verification
- The released SHA contains the Beeline OAuth path for Google connector setup
  (`connector-assignments.ts` and `connector-google.ts`). The phone folds Gmail,
  Calendar, Drive, and YouTube into the Google Workspace row and shows the first
  failed tool's error there.
- This attempt skipped the server deploy leg. Its OTA promotion proves delivery
  of the mobile update, not the state of this person's Google OAuth grant or
  helper connector assignments.
- The reported live row showed a Trusty Squire browser-lock error before this
  follow-up. No authenticated live Workbench row or fresh retry result was
  available in this corner, so the current exact error and recovery state remain
  **unverified**. Do not mark Gmail, Calendar, Drive, or YouTube fixed from this
  release run. A fresh Workbench Retry/Connect result is needed to identify the
  remaining error.

## Note to the next agent (this is the actionable plate)
The website leg's `pages-leg` build resolves `@beeline/api-contract/agent-access`
and `@beeline/nostr` from their `dist/` output. Those dist files were not present
in the website leg's working tree on main at this SHA. The repair must make the
website leg build or restore those two packages' `dist/`
(they are needed by `apps/body/src/access-policy.ts` / `apps/body/src/runtime.ts`
through the website bundle). At this attempted SHA, the missing outputs prevented
a successful unified release record. A later change (#1751) addressed the Pages
package build; it does not change this attempt's classified failure or prove
Google account recovery.
