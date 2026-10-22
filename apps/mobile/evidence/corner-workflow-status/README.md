# Quiet corner workflow status

Reproduction CR1 uses the real `CornerObjectiveLine` and `useRoomWorkflowRun`, with `listRoomWorkflowRuns` forced to reject. Production failures are intermittent; the controlled renderer is the stand-in recorded in the corner brief. No production session or data is changed.

On baseline `a04fb645e`, opening that objective prints the request error and an unexplained Retry button (`before-web.png`). On this branch the same failure leaves only the objective and Read brief. The last successful workflow stays visible during a failed refresh.

The browser regression renders both themes at phone and desktop widths. Screenshots named `web-*` capture the failed request, before recovery. The same regression then allows the operation to succeed and emits a Room invalidation after the cooldown: the workflow link appears without a user retry, and Read brief remains usable.

Run from `apps/mobile`:

```sh
CORNER_WORKFLOW_EVIDENCE=/tmp/corner-workflow-evidence npx vitest run sources/test/corner-workflow-recovery.browser.test.ts --maxWorkers=1
npx vitest run sources/buzz/use-room-workflow-run.test.tsx sources/buzz/use-observed-resource.test.tsx sources/components/buzz/CornerObjectiveLine.test.tsx sources/test/resource-observers.browser.test.ts --maxWorkers=2
```

Hook tests cover event bursts, foreground recovery, ordinary message recovery after failure, reopening and navigation focus while still mounted, retained data, one log per corner per JS session, and backoff increasing from one second to a thirty-second cap. Advancing the clock alone performs no retry. Healthy prose traffic still performs no workflow read; typed workflow projections still replace data without another request.

`DesktopRoomInspector` does not own this workflow error: its separate Retry recovers loading the entire selected corner. The shared objective component is also used in its embedded chat surface, so removing the workflow error props covers both layouts without hiding full-corner failures.

## Android

Built the actual native objective and workflow hook into a local release fixture for the isolated Android API 36 emulator. The operation stub rejects with `forced workflow fetch failure`; the source map confirms both that stub and the final focus-recovery hook are embedded. The native source is preserved in `native-fixture.md`. The fixture uses no production authentication and disables native OTA updates.

`android-obsidian.png` and `android-bone.png` show the failed load. UIAutomator confirms that the objective and Read brief are present, and that neither Retry nor the failure text is present in either theme. `android-workflow.txt` records exactly one warning across the two themes.

For the fixture, temporarily set the mobile package's main to `.workflow-proof/entry.tsx`, and resolve the phone operation, live connection, workbench source, corner facts and Expo Router imports to the supplied local stubs. Configure the generated Android manifest with Expo updates disabled, then build:

```sh
SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2 --console=plain
adb -s <isolated-emulator> install -r app/build/outputs/apk/release/app-release.apk
adb -s <isolated-emulator> shell am start -n app.usebeeline/.MainActivity
```

The build succeeded. Restored the production package main and Metro configuration after generating the fixture. Only evidence and regression tests retain the fixture; no failure-injection route ships in the app.
