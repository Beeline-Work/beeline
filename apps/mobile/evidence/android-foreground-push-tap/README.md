# android-foreground-push-tap

Foreground Android data-only pushes show `ForegroundPushToast` inside the app.
A tap opens the Room through the mounted navigator. The OS shade is not posted,
so MainActivity does not restart.

## Native Android (runtime 39)

Unsigned sign-in screen, emulator `buzzy_api36` (`emulator-5562`), release APK
`006fcc6afc…`. Same MainActivity instance; logcat has no
`ActivityTaskManager: START` after the tap.

| | Bone | Obsidian |
| --- | --- | --- |
| Notice | [in-app-notice.png](in-app-notice.png) | [in-app-notice-obsidian.png](in-app-notice-obsidian.png) |
| After tap | [after-tap.png](after-tap.png) | [after-tap-obsidian.png](after-tap-obsidian.png) |

Signed-in Play Review (Bone, `#general` → `#proof`) plus tap-to-Room times live
in `../android-native-revert-proof/`. Obsidian tap logcat:
[logcat-obsidian-tap.txt](logcat-obsidian-tap.txt). Route-mount **316 ms** after
the JS tap handler (`push-route-entry` → `route-mount`). Unsigned prefetch
failed, same as the Bone sign-in stand-in.

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
