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

The feature defaults OFF. Set `BEELINE_REPOSITORY_ONBOARDING=1` on the server to enable it only for GitHub user ids in `BEELINE_REPOSITORY_ONBOARDING_GITHUB_IDS` (default: `296966200`, the approved `methoxine-debug` account). Neither a supplied login nor a supplied user id enables the feature. No all-users switch is included.

An unknown first-time user initially sees the existing sign-in UI. OAuth verifies their GitHub id before any Beeline identity is created. Only an eligible account receives the Beeline install pre-screen; installation authorization must verify personal All repositories access before the native ticket is issued. A signed, expiring browser eligibility cookie permits direct install-first routing on later attempts; the callback still verifies the returned GitHub account. Non-allowlisted accounts retain the old path even while the rollout flag is on.

Review and merge the flagged implementation first; Ruby owns the release. Live acceptance runs on production only after that release and a new commander order. Before each run, uninstall the App from the test account and unlink its Beeline identity, retaining a log of each reset. Use the verified `methoxine-debug` Squire session without signing it out. Record the initial OAuth identification action when present; the target of four actions is not a claimed result.
