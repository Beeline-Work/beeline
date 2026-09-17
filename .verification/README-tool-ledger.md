# Tool ledger Android verification

Captured on 2026-09-17 from an isolated Pixel 6 / Android API 36 x86_64
emulator (`emulator-5556`, AVD `tool-ledger`, 1080x2400) using this branch's
release APK (`assembleRelease -PreactNativeArchitectures=x86_64`). Expo
Updates was disabled in the generated native manifest for the capture, so the
after images use the local bundle rather than a cached OTA.

## How the after images were captured

Current HEAD is monolith-only (#1010), so there is no on-device key-import
path and no local monolith server in the relay stack; the August-era relay
fixture flow (`tool-ledger-capture.yaml`, kept for reference) cannot run
anymore. The after images instead drive the REAL `ActivityTimeline`
component — the exact component corner transcripts render — through a
temporary, never-committed dev harness route (`sources/app/harness.tsx`,
git-excluded locally, deleted before any commit lands) fed with the same
fixture turn data the unit tests assert on:

1. Build: `cd apps/mobile/android && EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:3010 ./gradlew assembleRelease -PreactNativeArchitectures=x86_64`
2. Install on `emulator-5556`, cold-start, then `adb shell am start -a android.intent.action.VIEW -d "beeline://harness" app.usebeeline`.
3. `maestro test --device emulator-5556 --test-output-dir /tmp/maestro-out .verification/tool-ledger-harness-capture.yaml`

## Images

- `tool-ledger-before-expanded.png` — the pre-change stacked activity treatment
  (copied from the repository's API 36 corner evidence).
- `tool-ledger-after-collapsed.png` — the seven-step run folded to one line:
  `⌄ 7 steps · 1 failed · 51.0s` above the landing session's three individual
  lines. Agent prose stays primary; no cards, no chips.
- `tool-ledger-after-expanded.png` — the expanded run: one line per step,
  glyph + object label + quiet verdict, the failure's distilled reason
  (`command not found: pnpm`) inline, and the real 51-second thought duration.
- `tool-ledger-after-raw-sheet.png` — tap-open `HullActionSheetModal` with the
  selectable raw command output (`pnpm: command not found` …) and the
  transcript collapsed behind the modal.
- `tool-ledger-after-landing.png` — scrolled to the landing session: short
  runs stay individual lines (`verify signed owner approval`, `merge
  origin/main`, `push origin HEAD:main`).

## Provisioning history

`provision-tool-ledger.ts` (accepts `PROOF_AGENT_NSEC`/`PROOF_CORNER_ID`,
publishes relay fixtures only, no committed secret) provisioned the August-era
relay fixture corner the `tool-ledger-capture.yaml` flow targeted; that flow is
superseded by `tool-ledger-harness-capture.yaml` on this HEAD.
