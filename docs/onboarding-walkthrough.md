# GitHub onboarding walkthrough

This is a feature, not a defect report. The acceptance target is the approved A–F mock: install and authorize GitHub, explicitly join/create a Workspace, create/link a Room repository, choose a history-based starter, merge its PR through the normal gate, then switch repositories.

Use an isolated Android emulator with the candidate app installed and a browser already signed into a **dedicated test GitHub account**. Never use lunchboxfortwo's repositories. Run against production after the flagged implementation is released. The test account receives its own All repositories Beeline App installation during each run; OAuth during installation stays enabled with the existing production callback. The owner handles any GitHub security-key confirmation through the live browser card. No release pipeline changes are involved.

Run `npm run prove:onboarding` with:

- `ONBOARDING_GITHUB_LOGIN`: dedicated account login.
- `ONBOARDING_ANDROID_DEVICE`: explicit leased emulator id.
- `ONBOARDING_SWITCH_REPOSITORY_ID` and `ONBOARDING_SWITCH_REPOSITORY_NAME`: another repository in that account's installation.
- `ONBOARDING_INVITE_URL`: optional invite to test the join-first branch instead of creating a Workspace.
- `ONBOARDING_OUTPUT_DIR`: output directory (default `artifacts/onboarding-walkthrough`).

The runner stops at the first failure and saves Maestro logs, screenshots, segmented screen recordings and a manifest. Three runs must pass consecutively. GitHub's browser session is preserved while Beeline app state is cleared. Each successful create path intentionally creates a separate test Workspace and private repository. Keep them until their PR/check/review evidence has been inspected; delete only with explicit cleanup authority.

The flow gives the dedicated Workspace owner’s explicit merge yes in the task conversation, then waits for the merged event. It never directly calls GitHub merge, bypasses checks or changes reviewer settings. This approval is for the generated test PR, not for the onboarding implementation PR. Record the resulting PR URLs and inspect their exact heads, check rollups and independent approvals before claiming acceptance. The runner extracts the UI action counter into its manifest; confirm it against the recordings, including GitHub account/consent controls and the current face selection. Four is the target, not an assumed result. The create path automatically initializes README via existing GitHub creation, so that first commit happens before starter selection.

Live App settings and the dedicated account are external prerequisites. A locally passing service test is a stand-in for wiring and retry behavior, not a substitute for the three real Android runs.

Repository changes keep the existing Workspace owner/admin authority. A joined ordinary member can select a starter for a linked repository; they cannot change the Room's binding. The server returns `canLink` on the card, so the phone shows this limit instead of offering a control that will refuse. Removed free agents stay removed when another member joins.

## Revision 2 rollout

The feature defaults OFF. Set `BEELINE_REPOSITORY_ONBOARDING=1` on the server to enable Room repository cards for every signed-in user, including Google users with no GitHub link. The separate install-first GitHub browser preview retains its signed-cookie and GitHub-subject eligibility checks; public Room cards add no sign-in steps. Authentication, Workspace membership and repository-management permissions still apply.

An unknown first-time user initially sees the existing sign-in UI. OAuth verifies their GitHub id before any Beeline identity is created. Only an eligible account receives the Beeline install pre-screen; installation authorization must verify personal All repositories access before the native ticket is issued. A signed, expiring browser eligibility cookie permits direct install-first routing on later attempts; the callback still verifies the returned GitHub account. Non-allowlisted accounts retain the old path even while the rollout flag is on.

Review and merge the flagged implementation first; Ruby owns the release. Live acceptance runs on production only after that release and a new commander order. Before each run, uninstall the App from the test account and unlink its Beeline identity, retaining a log of each reset. Use the verified `methoxine-debug` Squire session without signing it out. Record the initial OAuth identification action when present; the target of four actions is not a claimed result.

## Google sign-in acceptance

Google sign-in uses the same Workspace, Room, repository and starter flow. The Google test subject must already be eligible under `BEELINE_GOOGLE_SIGN_IN` and `BEELINE_GOOGLE_SIGN_IN_SUBJECTS`. Enroll the test device once with `beeline://beeline/onboarding?google_preview=<token>` (web: `/?google_preview=<token>`), using the staged preview secret privately. Keep `BEELINE_GOOGLE_SIGN_IN_EVERYONE` unset. The token reveals the button only and never grants sign-in. Repository cards require `BEELINE_REPOSITORY_ONBOARDING=1` and are then available to every signed-in user. This does not change Google sign-in policy or link accounts by email or GitHub subject.

To select the Google variant of `scripts/onboarding-walkthrough.mjs`, supply `ONBOARDING_PROVIDER=google` and `ONBOARDING_GOOGLE_EMAIL` in addition to the dedicated GitHub account, device and switch-repository values above. The emulator browser must already have the dedicated Google session. `apps/mobile/e2e/google-repository-onboarding.yaml` signs in with Google, connects GitHub from the repository card, links or creates a repository, chooses a starter and waits for the normal merged result. The runner preserves recordings for all three passes. The Google account must remain the same identity after connecting GitHub; inspect its name, handle and provider rows before and after the run.

Record real iOS BrowserStack E1 and E3 separately using the candidate iOS app: complete Google sign-in and Workspace entry, edit the profile name, sign out, then sign in with the same Google account. Verify the same identity and the edited name, and retain the device recording. Android and service-test recordings do not replace iOS evidence.

A candidate implementation that has not been deployed cannot pass a production walkthrough. When the active order forbids deployments or production flag changes, report this acceptance dependency to the commander; do not deploy or change a rollout to manufacture acceptance. No successful live Google walkthrough is recorded by the automated service suites.
