# Settings tabs, revision 2: before/after screenshots

This is design review evidence only. Nothing here is a release.

- **before** = 8b6153f6d (PR 2741 head)
- **after** = this branch head (the Settings screens were recaptured after the compact switch and the shorter push title; the version line in some shots still reads afb5bedb9 because the dev build reports the last commit)
- **main** = origin/main c0d8e4578 (used only for the room-list header comparison)

Every screenshot comes from the full app, unedited. Android is an API 36 emulator at 412×915, density 160, font scale 1.3, so 1 px = 1 dp. Desktop is the Expo web app in headless Chrome at 1279×936, device scale 1. The app talks to an isolated in-memory PGlite server on loopback. No production accounts, servers or credentials were used.

## Files

| Shot | Android | Desktop |
| --- | --- | --- |
| Room list with ROOMS / DIRECT MESSAGES | `android-{before,after,main}-rooms.png` | `desktop-{before,after,main}-rooms.png` |
| Members with PEOPLE / AGENTS | `android-{before,after,main}-members.png` | `desktop-{before,after}-members.png` |
| Owner Settings, before (has a Workspace row) | `android-before-owner-settings.png` | `desktop-before-owner-settings.png` |
| Workspace screen reached from that row (before) | `android-before-workspace-screen.png` | `desktop-before-workspace-screen.png` |
| Owner Settings, You tab selected (after) | `android-after-you-tab.png`, `-bottom.png`, `-dark.png` | `desktop-after-you-tab.png`, `-dark.png` |
| Owner Settings, Beeline tab selected (after) | `android-after-workspace-tab.png`, `-bottom.png`, `-dark.png` | `desktop-after-workspace-tab.png`, `-dark.png` |
| Member Settings (role set to member, app restarted) | `android-{before,after}-member-settings.png` (after also has `-bottom.png` and `-dark.png`) | `desktop-{before,after}-member-settings.png` (after also has `-dark.png`) |
| Schedules and subscriptions for #beeline | `android-{before,after}-schedules.png` | `desktop-{before,after}-schedules.png` |
| Connectors ("Your connections") | `android-{before,after}-connectors.png` | `desktop-{before,after}-connectors.png` |
| Old route `/beeline/settings/workspace` as owner | `android-{before,after}-deeplink-owner.png` | `desktop-{before,after}-deeplink-owner.png` |
| Old route as member | `android-{before,after}-deeplink-member.png` | `desktop-{before,after}-deeplink-member.png` |

The `*.xml` files are uiautomator dumps of the Android room lists and the main Members screen. `measurements.json` holds the ROOMS header numbers and explains how they were measured. `measure.py` is the pixel-analysis script.

## How the shots were made

The `-dark` shots use Appearance = Dark (Android: `cmd uimode night yes`). All desktop "after" shots and `android-after-rooms.png` were retaken after the desktop sidebar got main's header height back; the other Android "after" shots come from 225bdf948; the tap line is desktop-only, so they do not change.


1. `server.mts` is a copy of `../members-settings-prototype/server.mts` with three additions: six schedules and four Room subscriptions seeded on #beeline (so Schedules has many rows), and `http://localhost:18082` added as an allowed web origin. Role toggle: `http://127.0.0.1:45861/_proof/role/member` (or `/owner`). Run it from the repo root with `node --import tsx apps/mobile/evidence/settings-tabs-revision2/server.mts`.
2. Boot the emulator with `beeline emulator -avd fm-members-frames -no-window -gpu swiftshader_indirect`. Then run `wm size 412x915`, `wm density 160` and `settings put system font_scale 1.3`. Install the existing debug APK; native code is the same in all three builds. Run `adb reverse tcp:45861` and `adb reverse tcp:18082`.
3. Run one Metro at a time on port 18082 from the build's worktree: `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:45861 npx expo start --dev-client --port 18082 --host localhost --max-workers 2`. Before was built in `/tmp/rev2-before` and main in `/tmp/rev2-main`, both throwaway git worktrees. All three lockfiles and `packages/` are identical, so node_modules was copied over instead of reinstalled.
4. `driver.sh launch | signin | role <r> | link <path>` cold-starts the dev client, signs in through `beeline://review/isolated-design-proof-secret-5678`, flips the role and opens deep links. `device.py` does the taps, uiautomator dumps and screenshots.
5. For desktop, Chrome runs headless with `--remote-debugging-port=19224`. `browser.mjs` sets the 1279×936 viewport, opens `http://localhost:18082/review/<secret>`, clicks by aria-label and takes screenshots.

## Stand-ins and environment notes

- Android notification permission was denied on purpose, the same way in every build. That makes Settings show a push failure row ("Push not reaching this device" before, "Push not working" after). It's a real app state, not something the change added. In the before captures the row happened to show only "Retry" at that moment.
- On desktop, connector logos show as black squares in both before and after, because the web build cannot load the logo images offline. Slack's white tile is wider, so its text is indented. This happens in before too.
- The gear in the top-right corner of the Android member shots is the Expo dev-client tools button. It is not part of the app.
- There are no stand-ins. Every shot was captured live.
