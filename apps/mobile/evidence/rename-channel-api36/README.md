# Rename channel — Android API 36 evidence

Captured on `emulator-5554` with the production release APK (`versionCode 23`) and an isolated throwaway Workspace/Room.

- `admin-menu.png`: Room owner sees **Rename Room** alongside **Delete Room**.
- `renamed-header.png`: applying `Renamed room` updates the open Room header immediately.
- `renamed-channel-list.png`: returning to the channel list shows the new display name.
- `non-admin-menu.png`: an invited member in the same Room sees **Leave Room** and no rename action.

After capture, the throwaway member was removed and the test Room was archived.

Fresh-clone verification after building workspace packages:

- `npm test -w @beeline/buzz-client` — exit 0, 20 files / 91 tests.
- `npm test -- --run` in `apps/mobile` — exit 0, 122 files / 1,063 tests.
- `npm run typecheck` — exit 0, all workspace and mobile checks.
