# Workspace picture — API 36 and live relay evidence

Validated on the existing `emulator-5554` (Android API 36) with the signed
production release APK, versionCode 17.

## On-device flow

- The owner selected `apps/mobile/logo.png` through Android's system photo
  picker. The app reused `pickAndUploadAvatar`, including the critical-chunk-only
  PNG canonicalization, and uploaded the 512px square result.
- The durable media URL immediately rendered in the Workspace header:
  [custom header](02-admin-custom-header.png).
- The same projected URL rendered in the Workspace rail:
  [custom rail](03-admin-custom-rail.png).
- A separate live Workspace projected the device identity as an ordinary
  member. UI automation asserted that `workspace-avatar-edit` was absent, and
  the header rendered the deterministic generated mark because the Workspace
  had no picture: [member fallback](04-non-admin-fallback.png).

## Production relay proof

Workspace `462055ab-d178-4753-9f41-a4c5310f5e54` projected:

- Media URL: `https://usebeeline.app/media/617bf48352afca690b82c3cea72ed68690692f35f384c7c599601da9d96259ae.png`
- Authenticated admin command: kind:9002,
  `df38a1e3a23902d3ef6c7b636b75a7e80b2dd0f80f2d8b64e6274ee2d53fb382`
- Relay-signed replaceable projection: kind:39000,
  `760624230fad89e78779822d1e23d1c0a59ba841c9dd3930fe3ad7ca0f5033e0`
- Both signatures verified, and the projection's `purpose` carried the exact
  namespaced media URL.

Member-only fixture `ca181d58-a70c-424c-83a7-118c311371c8` projected the same
device pubkey with role `member` and no picture.

## Verification commands

- `npm test -w @beeline/buzz-client` — exit 0, 19 files / 82 tests.
- Workspace picture live test against the local real relay — exit 0, including
  member read-through and non-admin write rejection.
- `npm run build && npm run typecheck` — exit 0, including mobile TypeScript.
- Full mobile Vitest suite — exit 0, 117 files / 1,028 tests.
- `npm run apk:release` in `apps/mobile` — exit 0, 2,249 Gradle tasks.
- `adb install -r` — exit 0; installed versionCode 17 on API 36.
