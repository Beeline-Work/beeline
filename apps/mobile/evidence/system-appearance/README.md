# System appearance proof

Feature request, not a defect report. Recorded on Linux, October 23, 2026.

The narrow browser fixture loads the production persistence, migration,
appearance listener, theme tokens, Unistyles web runtime, React Native Web
Appearance and Expo SystemUI. It substitutes only unavailable native MMKV
and expo-modules-core boundaries. Its HTML select exercises the same saved
preference and applyAppearanceChoice path as Settings; it is not the full
Settings screen. The actual three-choice picker is covered by
AppearanceSetting.test.tsx.

`browser-results.json` records live dark → light OS media changes, an explicit
Dark selection on a light system, and that selection surviving a reload.
Both the selected Unistyles theme and the computed canvas color match.

`desktop-results.json` was collected from the actual locally built Tauri
shell, serving that fixture at its configured development URL. An isolated
Xvfb/XSettings desktop changed Adwaita → Adwaita-dark → Adwaita while the
same window remained open. The webview reported false → true → false for
prefers-color-scheme: dark; React Native Web reported light → dark → light;
Unistyles selected bone → obsidian → bone, with matching computed root
backgrounds. Linux WebKitGTK therefore needs no shell bridge. App data and
XSettings were isolated from the person's desktop. The small webkit-probe.py
also independently confirms live media-query events in the same engine.

Native iOS/Android live following, explicit opt-out, return to System,
null fallback and text-size retention are covered at the Appearance event
boundary in unistyles.test.ts. These are automated platform tests with a
mocked OS boundary, not recorded device sessions. macOS/Windows Tauri run
the same tested web listener; no native macOS/Windows session was recorded.

Android splash: choosing System now clears the package night-mode override,
including on the migration launch. UiModeManager.setApplicationNightMode
maps MODE_NIGHT_AUTO to UI_MODE_NIGHT_UNDEFINED (it clears a package override,
unlike system-wide setNightMode's time-of-day behavior). Source:
https://android.googlesource.com/platform/frameworks/base/+/android16-release/services/core/java/com/android/server/UiModeManagerService.java
Native runtime advances to Android 40; iOS stays 36. Tests cover the splash
write and the configuration event emitted when clearing an old override.
An already displayed migration-launch splash cannot be repainted before JS
runs; later launches follow the OS.

To repeat the narrow proof:

- Run `node apps/mobile/evidence/system-appearance/build.mjs`.
- Run `python3 apps/mobile/evidence/system-appearance/server.py` to serve the
  fixture and collect JSON receipts on localhost:4199.
- Open Chromium with a disposable profile and CDP on localhost:9239, then run
  browser-proof.mjs. It checks both live themes and persistence after reload.
- Build the existing Tauri shell with a current Rust toolchain and two jobs.
  Place xsettingsd under /tmp/jellybean-appearance/extracted/usr/bin/.
  Run `xvfb-run -a python3 apps/mobile/evidence/system-appearance/desktop-proof.py <absolute-shell-binary>`.
- Run `xvfb-run -a python3 apps/mobile/evidence/system-appearance/webkit-probe.py`
  for the independent GTK engine check (requires Python GI and WebKit2 4.1).

Validation: root typecheck, UI component policy, focused appearance tests,
and both design lints pass. Native fingerprint check passes for Android 40
and iOS 36. The full app/device UI is not replaced by this fixture proof.
