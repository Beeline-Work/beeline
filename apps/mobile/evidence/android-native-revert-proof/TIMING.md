# Android push-tap proof (PR 2679 / 21e1654d)

Release APK `app-release.apk` sha256 `006fcc6afc539a854959945db9b6499f191ec7bbd3ed4fcde7a7d82a218433f5`, Hermes, not DEBUGGABLE, no DevLauncher, runtime 39. Emulator `se_api35` serial `emulator-5558`. Signed in as Play Review against the local latency-rig (`10.0.2.2:8081`). Push injected as C2DM `com.google.android.c2dm.intent.RECEIVE` to `app.usebeeline/com.google.firebase.iid.FirebaseInstanceIdReceiver` (project `31955293663`) — the production FCM receive path. Local rig has push delivery off, so Firebase-admin HTTP was not used.

Target Room: `#proof` (`bee11e00-0000-4000-8000-000000000103`) while `#general` was on screen (or last-open for background/cold). `#proof` is an empty review fixture, so the Room header paints and the jump target message is gone (`That message is no longer available`). Navigation is the criterion.

Times are emulator wall clock (`logcat -v threadtime`). Tap is `date +%s%3N` immediately before `input tap`. Room paint is first `[ROOM_OPEN] newest-frame` after that tap. `#proof` header was on screen at the first UI dump after each tap.

## Timing table

| case | tap | Room paint (newest-frame) | tap-to-Room | pid | MainActivity record | ActivityTaskManager START |
| --- | --- | --- | --- | --- | --- | --- |
| foreground (in-app notice) | 21:52:22.053 | 21:52:22.224 | **171 ms** | 4467 | `ActivityRecord{cc73aea u0 app.usebeeline/.MainActivity t8}` unchanged | **none** |
| background (shade tap, process alive) | 21:53:45.485 | 21:53:45.715 | **230 ms** | 4467 | same `cc73aea t8` | trampoline + MainActivity `LAUNCH_SINGLE_TASK` **result=3** (`START_DELIVERED_TO_TOP`) |
| cold (`HOME` then `am kill`, process gone, then shade tap) | 21:57:07.950 | 21:57:08.523 | **573 ms** | 4467 → **6670** | task reused `cc73aea t8` | trampoline + MainActivity `LAUNCH_SINGLE_TASK` **result=3**; **no DevLauncher** |

## Unsigned prefetch

Speedy’s unsigned prefetch was the unsigned session (debug/dev-client, not signed in). After Play Review sign-in on this release APK, logcat has **zero** `unsigned` lines. Prefetch completed: foreground `prefetch-end` + `messages:0` (empty fixture), not an unsigned error.

## Foreground START

`rg "ActivityTaskManager: START" logcat-fg-tap2.txt` → **0 matches**. Routing: `Navigating to Beeline message: bee11e00-0000-4000-8000-000000000103`.

## Background START

```
10-20 21:53:45.525 I ActivityTaskManager: START u0 {dat=expo-notifications://notifications/... cmp=app.usebeeline/expo.modules.notifications.service.NotificationForwarderActivity} result code=0
10-20 21:53:45.539 I ActivityTaskManager: START u0 {cmp=app.usebeeline/.PushNotificationActivity} result code=0
10-20 21:53:45.555 I ActivityTaskManager: START u0 {cmp=app.usebeeline/.MainActivity} LAUNCH_SINGLE_TASK result code=3
10-20 21:53:45.717 W ReactNativeJS: [PUSH ROUTING] Navigating to Beeline message: bee11e00-0000-4000-8000-000000000103
```

## Cold START

`am kill` after HOME: pid 4467 gone. C2DM woke pid 6670 to post the shade notification. Tap:

```
10-20 21:57:07.957 I ActivityTaskManager: START u0 {cmp=app.usebeeline/expo.modules.notifications.service.NotificationForwarderActivity} result code=0
10-20 21:57:07.972 I ActivityTaskManager: START u0 {cmp=app.usebeeline/.PushNotificationActivity} result code=0
10-20 21:57:07.996 I ActivityTaskManager: START u0 {cmp=app.usebeeline/.MainActivity} LAUNCH_SINGLE_TASK result code=3
10-20 21:57:08.510 W ReactNativeJS: [PUSH ROUTING] Navigating to Beeline message: bee11e00-0000-4000-8000-000000000103
```

No `DevLauncher` / `expo.modules.devlauncher` in fg, bg, or cold logcats.
