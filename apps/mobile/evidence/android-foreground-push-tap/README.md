# android-foreground-push-tap

Foreground Android data-only pushes show `ForegroundPushToast` inside the app.
A tap opens the Room through the mounted navigator. The OS shade is not posted,
so MainActivity does not restart.

## Signed-in Play Review (release APK, runtime 39)

Release APK sha256 `006fcc6afc539a854959945db9b6499f191ec7bbd3ed4fcde7a7d82a218433f5`.
Local latency-rig (`10.0.2.2:8081`). Push injected as C2DM
`com.google.android.c2dm.intent.RECEIVE` to
`app.usebeeline/com.google.firebase.iid.FirebaseInstanceIdReceiver`
(project `31955293663`). Target `#proof`
(`bee11e00-0000-4000-8000-000000000103`) while `#general` was on screen.

| | Bone | Obsidian |
| --- | --- | --- |
| Notice | [fg-in-app-notice.png](../android-native-revert-proof/fg-in-app-notice.png) | [in-app-notice-obsidian.png](in-app-notice-obsidian.png) |
| After tap | [fg-after-tap.png](../android-native-revert-proof/fg-after-tap.png) | [after-tap-obsidian.png](after-tap-obsidian.png) |

Obsidian: emulator `se_api35` (`emulator-5562`), system night mode, Play Review
session. In-app plate `foreground-push-notice` ("Beeline" / "proof ping from
other room"). Tap opened `#proof`. Same MainActivity
`ActivityRecord{4338b7d u0 app.usebeeline/.MainActivity t8}` pid 4234. Logcat
had **0** `ActivityTaskManager: START` after the tap. Tap-to-Room
(`push-route-entry` 23:35:09.956 → first `newest-frame` 23:35:10.207):
**251 ms**. Logcat: [logcat-obsidian-tap.txt](logcat-obsidian-tap.txt).

Bone signed-in times live in `../android-native-revert-proof/` (foreground
**171 ms**, same no-START result).

## Both themes (production toast)

`sources/test/foreground-push-toast.browser.test.ts` renders the production
`ForegroundPushToast` at 390px with bundled fonts:

| | Obsidian | Bone |
| --- | --- | --- |
| Notice | [in-app-notice-web-obsidian.png](in-app-notice-web-obsidian.png) | [in-app-notice-web-bone.png](in-app-notice-web-bone.png) |
| After tap | [after-tap-web-obsidian.png](after-tap-web-obsidian.png) | [after-tap-web-bone.png](after-tap-web-bone.png) |

From `apps/mobile`:

```sh
npx vitest run sources/test/foreground-push-toast.browser.test.ts
```
