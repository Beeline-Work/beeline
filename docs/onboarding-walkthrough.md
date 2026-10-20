# GitHub onboarding walkthrough

This is a feature, not a defect report. The acceptance target is the approved A–F mock: install and authorize GitHub, explicitly join/create a Workspace, create/link a Room repository, choose a history-based starter, merge its PR through the normal gate, then switch repositories.

Use an isolated Android emulator with the candidate app installed and a browser already signed into a **dedicated test GitHub account**. Never use lunchboxfortwo's repositories. The test account needs its own All repositories Beeline App installation; the App must have OAuth during installation enabled with its first callback pointing at the candidate auth server. The owner handles any GitHub security-key confirmation. No release pipeline changes are involved.

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
