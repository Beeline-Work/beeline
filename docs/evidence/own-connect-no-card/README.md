# Owner connection consent — Reproduction R1

The owner’s own agent should connect the owner’s app without a permission card. Other-account connection cards name the asking agent and the product.

## Reproduced

The production web conversation list, signed in as lunchboxfortwo, displayed “@lunchboxfortwo wants Jellybean to use connection-install:github”. This confirms the reported production state; it is not a reviewer-session check.

The isolated server reproduction POSTs `/v1/daemon/operations/connect` for GitHub under an active owner-authored command, using the real server handler and a PGlite database. Registry and provider responses are fixed stand-ins to avoid provisioning production accounts. With the original daemon source restored, the same request returned `needs_approval` instead of `needs_squire`: [baseline output](r1-before.txt). No release was dispatched.

## Demonstrated

The same HTTP path now returns `needs_squire`, records approved automatic consent, and creates no grant-request message. API and browser setup, already signed-in readiness, reconnect, legacy denied/once rows, third-party requester provenance across boot, stale-card withdrawal, foreign-account ownership/decision and tray wording are covered by the focused run: [passing output](r1-after.txt).

The Android screenshot renders the production `GrantRequestCard` in Expo Go on Android 35 with an explicit foreign-account fixture: [screenshot](android-foreign-card.png). UI Automator read “@Jellybean wants to connect GitHub”, “No”, “Once”, “Always”. This is a native component proof, not an authenticated production account. Only unrelated device/service/theme boundaries use the existing notice-style proof adapters. SVG is pinned to Expo SDK 55’s native version.

Recreate with `npm ci --prefix apps/mobile/connection-consent-proof --legacy-peer-deps --ignore-scripts`, then run the mobile Expo CLI against `connection-consent-proof --android`. Use a leased emulator and select its serial explicitly.

## Validation

- Focused server regressions: 15 passed, 112 skipped.
- API contract / guard tests: 164 passed.
- Mobile grant copy: 5 passed.
- Root `npm run typecheck`: passed.
- `npm run dead-code`: baseline holds, no introduced findings.

## Outstanding web acceptance

`web.usebeeline.app` opened successfully through Trusty Squire in an existing lunchboxfortwo session. Vault metadata confirmed `beeline-reviewer-bypass` / `play-review-login-link` with field `value`. Secure `operate_login(action:load_saved, fields:[value])` failed with `unsupported_credential_type`. The mounted navigate operation accepts a plaintext URL and offers no sealed-link navigation. No raw secret was fetched. A live browser share was posted and reviewer sign-in handback requested; no handback was received in this turn. Therefore the requested GitHub-reviewer-bypass browser acceptance is not claimed. Production fixed-behavior proof also awaits deployment by the normal release owner.

Boot cleanup ships in the migration; production data has not been manually modified.
