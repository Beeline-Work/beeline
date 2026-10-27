# Two-agent onboarding evidence

This is a feature, not a defect report. The governing assignment is brief revision 4.

## Demonstrated: ONBOARDING-2

Run `npm run prove:two-agent-onboarding`. The script imports the built server's
PhoneService, provisioning, artifact storage and funnel implementations. It
creates an isolated user and Workspace, reads the welcome A–D card, selects D,
reads the fixed explanation and A–C follow-up, selects B, reads Luna's stored
game and Beebee's next-step card, then selects its invite option. Assertions
check the static board, embedded PNG faces, absence of external URLs and invite
buttons in the game, printed invite link and zero model commands. Output goes to
`/tmp/beeline-two-agent-proof`, or `ONBOARDING_PROOF_OUTPUT`.

PGlite and in-memory object storage replace production PostgreSQL and Tigris.
No Fly Machine or live model is used. The model proxy regression separately
executes authenticated HTTP requests for both teammates and verifies stored
model selection and one shared owner allowance. Live model interpretation of
the optional second-opinion prompt is not evaluated by these deterministic proofs.

The template is recovered exactly as Ruby's private order
`815725790fd8989147c7bb48170e104d914c5b16e5b5f0dfc2bf249fa4082768`
instructed: replace the filled faces, names and JSON with placeholders. Its
original offline end screen already contains only Play again.

## Android stand-in

The screenshots use the existing Expo Go surface harness on `emulator-5554`,
with production TranscriptCard and RunnableArtifact components and DTOs/files
produced by ONBOARDING-2. This replaces a signed-in production app session;
fixture navigation selects the already-executed service responses. Native
IdentityMark's SVG binary is incompatible with this Expo Go binary, so the
harness displays server-rendered PNGs. Those PNGs are generated from the
mobile drawings, edge layers and palette. Explanation prose uses the harness's
plain Text rather than the app's Markdown renderer. The native viewer executes
the actual filled game; the inline preview disables JavaScript.

After the service proof, serve its output with
`python3 -m http.server 8127 --bind 127.0.0.1 --directory /tmp/beeline-two-agent-proof`.
Reverse ports 8127 and 8100 to the emulator, set the surface harness to
`onboarding`, and start Expo Go on port 8100. The harness transport and telemetry
are adapters; it does not send fixture data to production.

- [Welcome A–D](android-welcome.png)
- [Fixed D answer and A–C](android-explanation.png)
- [Game post, inert preview and next-step card](android-game-post.png)
- [Opened game](android-game-viewer.png)
- [Game move and coaching](android-game-playing.png)
- [Printed invite link](android-invite-link.png)

The local proof rerolls agent identities on each execution. Capture a screenshot
set from one proof run; do not rerun the service proof between captures.

## Dashboard integration

The dashboard frontend is assigned to corner `6d0af568`. This repository exposes
`periods["24h"|"7d"|"28d"|"all"].onboardingFunnel` using the pinned
[API contract](api-contract.md). Counts deduplicate authenticated humans, use
first welcome and first choice, exclude team installs, and suppress medians below
five samples. Return eligibility starts at welcome. The Android screenshots here
cover the app surfaces; the dashboard corner owns its view and proof.

## Validation

- Root `npm run typecheck`, including mobile and scripts.
- Server provisioning, proxy, funnel and ordinary routing suites; additional
  regressions cover game/invite, untagged starter routing, prompt-only review routing and
  return milestones.
- Mobile transcript card, runnable viewer and funnel client suites.
- Shared funnel schema/client and phone contract tests.
- `npm run faces:check`: generated face data matches the mobile sources.
- `npm run dead-code`, UI component policy and workflow-path checks.

Revision 4 moves the question into the greeting, suppresses the welcome card title, removes option subtitles, and changes D to the owner-approved label. Invites are plain Beebee chat messages, with invite_shared recorded on the server when posted. No onboarding share sheet or forced review is used. The existing choice-label bound is raised to 48 characters to fit the exact D wording.
