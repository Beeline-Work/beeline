# Two-agent onboarding evidence

This is a feature, not a defect report. The governing assignment is brief revision 2.

## Demonstrated: ONBOARDING-2

Run `npm run prove:two-agent-onboarding`. The script imports the built server's
PhoneService, provisioning, artifact storage and funnel implementations. It
creates an isolated user and Workspace, reads the welcome A–D card, selects D,
reads the fixed explanation and A–C follow-up, selects B, reads Luna's stored
game and Beebee's next-step card, then selects its invite option. Assertions
check the static board, embedded PNG faces, absence of external URLs and invite
buttons in the game, share text and zero model commands. Output goes to
`/tmp/beeline-two-agent-proof`, or `ONBOARDING_PROOF_OUTPUT`.

PGlite and in-memory object storage replace production PostgreSQL and Tigris.
No Fly Machine or live model is used. The model proxy regression separately
executes authenticated HTTP requests for both teammates and verifies stored
model selection and one shared owner allowance. Live model interpretation of
the shared review prompt is not evaluated by these deterministic proofs.

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
- [Native share sheet](android-share-sheet.png)
- [Dashboard companion preview](android-dashboard-preview.png)

The local proof rerolls agent identities on each execution. Capture a screenshot
set from one proof run; do not rerun the service proof between captures.

## Dashboard companion

The frontend lives in `Beeline-Work/beeline-dashboard`, not this repository.
The corner's GitHub App cannot access that repository (404); the connected
GitHub repository search also returned none. The owner's vaulted dashboard
credential successfully read its current source. No personal-route repository
writes were performed.

[dashboard-onboarding.patch](dashboard-onboarding.patch) is a concrete companion
change against the current frontend. It appends the new aggregate view to the
existing period view, reuses its classes, escapes output, and includes a Node
renderer test. It passes `git apply --check` against the fetched source and its
renderer test passes. It needs the dashboard repository's own App-backed corner
to apply, validate and publish. A local rendering preview is not proof that the
live dashboard has changed.

## Validation

- Root `npm run typecheck`, including mobile and scripts.
- Server provisioning, proxy, funnel and ordinary routing suites; additional
  regressions cover game/invite, untagged starter routing, one review round and
  return milestones.
- Mobile transcript card, runnable viewer and funnel client suites.
- Shared funnel schema/client and phone contract tests.
- `npm run faces:check`: generated face data matches the mobile sources.
- `npm run dead-code`, UI component policy and workflow-path checks.
