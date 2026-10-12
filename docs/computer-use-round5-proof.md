# Computer viewer opening proof — round 5

F3 opens the full viewer immediately with the mounted preview's access token. A single capture transfers its latest frame while the viewer connects. Authorization refresh runs in the background without replacing a valid stream URL; an expired token retries with refreshed access, and an authoritative refusal removes the stream. The opening frame disappears on the full stream's first decoded paint or session end. The visible controls remain Open and Close.

## Validation

- Root `npm run typecheck`: passed.
- ComputerSession component regressions: 16 passed, including a stalled authorization RPC, preview-frame transfer, expired-token retry, access refusal, transient failure, late capture, and session end during opening.
- Related sandbox-WebView regressions: 2 passed.
- Shared api-contract suite: 465 passed.
- Android `:app:assembleRelease -PreactNativeArchitectures=x86_64`: passed. APK SHA-256: `ad25ca95d365c7b1da1967e7b82f2b499b5a0d7e8ed730ddb82ffdb4a691fab3`. This local release variant uses the Android debug signing key, has no DEBUGGABLE flag, and disables OTA updates for proof; it is not a store-signed binary.

## Live web timings

Captured on 2026-10-12 UTC, using the changed local web app, real production v0.1.30 computer streams, and the Beeline Review Workspace. An isolated helper used `/tmp/b5.J1mbQU`; no shared helper was restarted or changed. Chromium was a dedicated chrome-devtools-axi instance. Squire used a real new operate session on the same public HTTPBin form.

The local web API proxy forwards the review client's requests to production and permits the localhost origin; viewer HTTP/WebSocket traffic goes directly to production. The local app ran under Expo's development web server. These numbers establish this web check, not Android release performance.

The timer starts immediately before the real card's DOM click handler. It stops on `computer-first-frame` from the **full viewer iframe**, excluding notifications from the preview. This event reports a decoded browser frame. Browser operations ran through chrome-devtools-axi.

| Source | Sample 1 | Sample 2 | Sample 3 | Sample 4 | Sample 5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 334 ms | 412 ms | 359 ms | 342 ms | 510 ms |
| Squire | 173 ms | 137 ms | 123 ms | 189 ms | 139 ms |

All ten samples are below 1 s.

## Android timing: pending

The isolated read-only emulator was launched on port 5572; every adb command targeted emulator-5572. The inherited image's older `app.usebeeline.harness` was stopped, and the newly built `app.usebeeline` release was selected explicitly. A clean-data review sign-in loaded the Room deck, but the release app continued reporting `RoomViewHttpError: Room view request failed (0 timeout)` with cached Room content. No native tap-to-paint timing claim is made.

Firstmate's inbox instruction 002 authorizes delivery with web timing and native timing pending; its post-release production proof will measure Android. F1/F2 remain separate upstream/consumer work and are not claimed by this F3 change.
