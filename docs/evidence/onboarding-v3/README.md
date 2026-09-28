# Onboarding v3 — real-app evidence

Every frame is the real Expo web client (production bundle, `expo start --web --no-dev --minify`)
at 390×844 (DPR 2). It ran against a local server built from this branch: the design-audit
fixture (`.verification/design-audit/fixture-server.mts`) on a fresh in-memory PGlite database
for each theme. Dark and light follow the browser's `prefers-color-scheme` on a first run with
cleared storage.

## Capture recipe

1. Start the fixture. For the walk, its GitHub verifier also mapped one ticket (`o` × 43) to a
   brand-new person, `Octo Cat` (`@octocat`). That change lived in a scratch copy and was not
   committed.
2. **A → E, new person:**
   - Open `/beeline/onboarding` and capture **A**.
   - Park a pending sign-in state and open the app's own `/beeline/github-callback?…` route with
     that ticket. The app exchanges it with the server and shows **B**.
   - Pick a face and tap Continue: the app routes a person with no Workspace to **C**.
   - Tap Create a Workspace (**D**), type `Northstar Lab`, and tap Create Workspace: this lands
     in **E**, `#general`.
   - Open Workbench (Trusty Squire not connected) for **T3**.
3. **T1 and T2, existing member:** the fixture's seeded member opens the Room list (**T2**,
   `#ship-the-slab` has a corner) and then that Room (**T1**, messages from agents and another
   person).
4. "Got it" was pressed after each tip; the walk checked that the tip was gone afterwards.

## Frames

| Screen | Dark | Light |
| --- | --- | --- |
| A. Sign in | `A-sign-in-dark.png` | `A-sign-in-light.png` |
| B. You (name + face) | `B-you-dark.png` | `B-you-light.png` |
| C. Create or join | `C-create-or-join-dark.png` | `C-create-or-join-light.png` |
| D. Name the Workspace | `D-name-workspace-dark.png` | `D-name-workspace-light.png` |
| E. `#general` | `E-general-dark.png` | `E-general-light.png` |
| T1. Swipe right to open a corner | `T1-swipe-dark.png` | `T1-swipe-light.png` |
| T2. This Room has corners | `T2-corner-mark-dark.png` | `T2-corner-mark-light.png` |
| T3. Trusty Squire | `T3-squire-dark.png` | `T3-squire-light.png` |
