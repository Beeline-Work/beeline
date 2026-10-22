# GitHub onboarding recovery proof

Reproduction GITHUB-EXISTING-INSTALLATION: the owner's Android report and a separate GitHub test identity both reach GitHub installation settings when the App is already installed. Save is disabled without a repository-access change. Redirect on update does not make account selection return to Beeline. The old native cancellation handler also erased the saved Room path.

The Android stand-in uses the actual shared ErrorBanner, Button, error mapping, repository card and installation return monitor. Error states are deterministic fixtures, captured in Bone and Obsidian. The picker proof connects the actual card over HTTP to the production PhoneService implementation and migrations in an isolated PGlite database. Its GitHub boundary contains an already-installed organization and a repository; no production identity or token is used. This demonstrates the visible path before deployment, rather than claiming the changed server is already running in production.

From the repository root, start `node --import tsx apps/mobile/evidence/github-onboarding-recovery/server.mjs`. For the isolated generated Android build only, set React `entryFile` to `../../evidence/github-onboarding-recovery/entry.js` and temporarily replace the root mobile Metro config with the proof resolver in `metro.cjs` (preserving the original adjacent to it and adjusting its require path). Expo embed ignores the CLI config option here, so verify `.scratch/github-proof` was generated before claiming connected proof. Allow cleartext traffic in that generated proof manifest so the emulator can reach the local service. These generated Android changes must be restored after capture; they are not product changes. Build with x86_64, two Gradle workers, and a bounded heap, then install on the leased emulator. `capture.py` captures error fixtures. Open `beeline://onboarding-proof?state=picker&theme=bone`, tap Install Beeline, and verify the repository appears without a browser opening. Add Beeline to an org opens a real GitHub tab; close it and verify foreground refresh restores the picker. GitHub's actual settings and authorization remain outside this local service fixture.

WELCOME-FRESH-ANDROID did not reproduce the reported Get started loop: a separate test account advanced once per tap and reached its Room on the first Get started tap. Welcome code is deliberately unchanged, as ordered.

The required production web reviewer-bypass proof remains unavailable: the connected saved-link credential was ready, but Squire load_saved rejected its `value` credential type, and browser navigation does not accept a sealed slot. A separate test identity's web signup reached an account mismatch. No successful reviewer-bypass web test or complete unassisted GitHub signup is claimed. Those deployed checks remain required.

## Full-screen recovery regression

Reproduction GITHUB-FULL-SCREEN-ACTIONS: on the actual onboarding screen, Continue with GitHub while offline displayed both Try again and Continue with Google as primary actions. Before an error, GitHub used the provider variant (white in Bone). The callback component tests exercise this full screen, including cancellation and expiry, rather than a standalone banner.

`full-screen.js` configures the real app themes before loading the actual `BuzzOnboarding` screen, shared controls, and fonts. `full-screen.metro.cjs` isolates account/session, storage, transport, and telemetry boundaries; its sign-in boundary deterministically rejects offline. Cancellation and expiry use the real notice publisher. No sign-in or external GitHub transaction is claimed.

Build the generated Android project from the repository root with the isolated overrides below. These select the proof entry and resolver without editing the product Metro or Gradle configuration:

```sh
BEELINE_PROOF_ENTRY="$PWD/apps/mobile/evidence/github-onboarding-recovery/full-screen.js" \
EXPO_OVERRIDE_METRO_CONFIG="$PWD/apps/mobile/evidence/github-onboarding-recovery/full-screen.metro.cjs" \
NODE_ENV=production apps/mobile/android/gradlew -p apps/mobile/android :app:assembleRelease \
  --init-script "$PWD/apps/mobile/evidence/github-onboarding-recovery/full-screen.gradle" \
  --no-daemon --project-cache-dir /tmp/onboarding-proof-gradle-cache \
  -PreactNativeArchitectures=x86_64 --max-workers=2 \
  -Dorg.gradle.jvmargs='-Xmx4g -XX:MaxMetaspaceSize=1g'
```

Install the APK on the leased emulator, then run `python3 apps/mobile/evidence/github-onboarding-recovery/capture-full-screen.py emulator-PORT OUTPUT_DIRECTORY`.

The capture checks the full initial screen, cancellation, expiry, and a tap through the real sign-in handler into offline recovery in Bone and Obsidian. Each error screen must expose exactly one recovery action; the initial screen retains both providers with GitHub primary.
