# android-metro-local-stack

Brief revision 3 verification: existing debug/dev-client APK on squire, PR JS from Metro, local Postgres + server, disposable identities via `/v1/auth/github/exchange` (`local:<login>`).

- Emulator: `emulator-5558` (`app.usebeeline`, DEBUGGABLE).
- Metro: `*:18797` with `adb reverse tcp:18797 tcp:18797`.
- Server: `127.0.0.1:18796`, `NODE_ENV=development`, database `beeline_corner_2b586c06`.
- Workspace Push Proof `dbca3eca-fe29-43c3-80f7-57e1eedaded6`.
- Target `#proof` `377b2b7e-a224-4eda-95de-2f4f0b25a74d` (mate pings include `0df72dd6…`).

This stack cannot deliver FCM (`PUSH_DELIVERY_ENABLED=false`, no Firebase). Foreground used the same JS API the FCM received listener calls: `presentForegroundPushNotice` with the mate `#proof` payload. A quoted C2DM inject reached the receiver and did not call Expo `onMessageReceived`.

## Foreground

| | Shot |
| --- | --- |
| In-app notice | [fg-in-app-notice.png](fg-in-app-notice.png) |
| After tap | [fg-after-tap.png](fg-after-tap.png) |

Notice over the Room list ("proof" / "proof ping from other room"). Tap opened `#proof` with mate's pings. Same MainActivity `ActivityRecord{210816272 u0 app.usebeeline/.MainActivity t10}`. Logcat had **0** `ActivityTaskManager: START` after the tap. Tap-to-Room (`push-route-entry` 00:10:50.389 → first `newest-frame` 00:10:51.654): **1265 ms** (Metro debug). Logcat: [logcat-fg-excerpt.txt](logcat-fg-excerpt.txt).

## Background

Process alive. v0.1.89 `PushNotificationActivity` trampoline with `#proof` extras. Opened `#proof`. MainActivity `LAUNCH_SINGLE_TASK` result code 3 (`START_DELIVERED_TO_TOP`). Same ActivityRecord t10. [bg-after-tap.png](bg-after-tap.png), [logcat-bg-excerpt.txt](logcat-bg-excerpt.txt).

## Cold start

`am force-stop` then the same trampoline. Focused `DevLauncherActivity` (acceptable for this debug APK): [cold-devlauncher.png](cold-devlauncher.png). After connecting the recent Metro URL `http://127.0.0.1:18797`, `#proof` rendered with mate's pings: [cold-after-devlauncher.png](cold-after-devlauncher.png). [logcat-cold-excerpt.txt](logcat-cold-excerpt.txt).

## Fingerprint

`npm run fingerprint:check` with the probe flag unset:

```
runtime {"android":"39","ios":"36"} still describes this tree: android 596e1c7a9afd328d0a9a88ef2b3a3c873e9466a5, ios 831938dc46dab9517152283c79603577d5765008
```

Android stamp equals v0.1.89.
