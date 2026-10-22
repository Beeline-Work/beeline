# Short onboarding flow

This is a feature request, not a defect report. A fresh account goes from provider sign-in to Workspace creation to #general, without identity selection or welcome slides. Beebee posts the approved lessons once, with the repository card below the hello.

## Demonstrated

`preview.tsx` mounts the production sign-in and create-Workspace routes. Actual buttons and the actual Workspace input drive their callbacks. The local service runs real migrations, provider identity allocation, `PhoneService.createWorkspace`, free-agent creation and `PhoneService.readRoom`. Each Workspace create is replayed by the service to verify idempotence. Each Room read asserts exactly one hello and one repository card. The focused Room renderer mounts the production Ledger, system line and repository card components with that committed response.

`web/`, `desktop/` and `android/` contain the same path for Google and GitHub in Bone and Obsidian. Each path captures sign-in, Workspace creation and #general; Android also captures the repository card after scrolling. `results.json` and `android/results.json` record the visible text.

Limits: provider verification is a deterministic local boundary, not an external OAuth transaction. No production identity or Workspace is created. Fly Machines are not started. Web uses this local service stand-in because the reviewer bypass is broken (fb_084fb788). Desktop runs the shared route's Tauri branch in Chromium; this is not an installer or desktop OAuth proof. Android runs real React Native, Unistyles, SVGs and bundled fonts in a debug native shell, loading the changed JavaScript from Metro. The native shell's developer Tools affordance is visible. The focused Room renderer omits the surrounding Room shell and composer; it does not substitute the hello or repository-card components.

## Reproduce

From the repository root:

```sh
node --import tsx apps/mobile/evidence/onboarding-short-flow/server.mts
ONBOARDING_SHIMS=/tmp/onboarding-shims.json node --import tsx apps/mobile/evidence/onboarding-short-flow/preview.mjs
python3 -m http.server 4197 --bind 127.0.0.1 --directory /tmp/jellybean-short-flow
```

Launch headless Chrome with remote debugging on port 9337, then run `node apps/mobile/evidence/onboarding-short-flow/capture.mjs`.

For Android, lease an emulator with `beeline emulator`, install a compatible debug shell, and update the capture script's device serial. Generate the native fixture with `ONBOARDING_THEME=obsidian node apps/mobile/evidence/onboarding-short-flow/prepare-native.cjs`. Temporarily point the mobile package entry at `.scratch/onboarding-native/entry.js`, start Expo with `EXPO_OVERRIDE_METRO_CONFIG=metro.onboarding-proof.cjs` on port 8197, and reverse that port through adb. Launch the development client. Run `ONBOARDING_THEMES=obsidian python3 apps/mobile/evidence/onboarding-short-flow/capture-android.py`. Repeat with Bone, restarting the native app after generating that theme so static styles initialize consistently. Restore the normal `index.ts` entry and remove the generated Metro config afterward. All native fixture files under `.scratch` remain ignored.

## Regression coverage

- Callback routing enters the app directly after sign-in, including a warm callback that routes a second screen and a recovered cold callback. Neither handles nor faces are rewritten.
- Workspace creation opens its #general and preserves idempotent retries.
- The exact hello is stored once, without a model turn, and the repository card sorts strictly after it using the existing system-line ordering mechanism.
- Older clients receive `due: false` regardless of the legacy welcome flag; Settings identity editing remains covered by its existing HTTP test.
- Anonymous funnel events record successful Workspace/message writes once per sign-in attempt, including after an app restart, require authentication and appear in the dashboard. Completed attribution expires with the existing anonymous ledger retention window; unfinished OAuth attempts retain their shorter expiry.

## Validation results

- Full mobile suite: passed (593 files, 4 skipped; 4,842 tests, 5 skipped).
- Final callback/funnel tests: passed (27 tests); final transport tests: passed (25 tests).
- Free-agent and repository-onboarding suites: passed (35 tests), including exact hello and card ordering.
- Sign-in funnel and operator dashboard suites: passed (27 tests).
- Targeted real HTTP welcome retirement and Settings identity editing: passed (one test each).
- Root typecheck, UI component policy, dead-code baseline, workflow test-path lint and shared API contract suite (497 tests): passed.

The broad server integration attempt lost its worker partway through. It is not counted as passing. The affected welcome and identity HTTP paths were rerun separately and passed; complete CI remains the final gate.
