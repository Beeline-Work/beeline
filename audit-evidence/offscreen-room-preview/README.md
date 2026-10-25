# NET-HOL-1: offscreen Room message preview

An offscreen Room's full message occupied the single live connection before the active Room's message. The approved replay kit recorded offscreen payloads of (131,796 bytes), followed by active payloads of (733 bytes). Active arrival was (705–725 ms) on throttled web and (733–742 ms) on throttled Android. Its matched server/proxy ledger attributed roughly (581–616 ms) to queueing. This was a controlled stress case, not a production percentile.

## Demonstrated

The same fixture stimulus inserts an offscreen message with (128 KiB) of text, waits (50 ms), then inserts an active Room message. Each platform ran three normal and three throttled trials. Normal shaping: (0 ms RTT / 100 Mbps). Throttled shaping: (150 ms RTT / 1.6 Mbps), without jitter or failures. The proxy and fixture database were loopback-only and separate from production.

| Final capture | Normal active arrival | Throttled active arrival | Throttled proxy delivery | Offscreen frame |
| --- | --- | --- | --- | --- |
| Built desktop web | (19–28 ms) | (100–106 ms) | (78–79 ms) | sidebar-preview (670–671 bytes) |
| Android release | (7–20 ms) | (84–93 ms) | (78–79 ms) | sidebar-preview (671 bytes) |

Proxy delivery measures from the backend frame reaching the proxy until transmission to the client, excluding database projection. Its own shaping time is approximately (75 ms) propagation plus (4 ms) serialization. There is no remaining queue behind the offscreen text. Android's host/device clock calibration has sampling uncertainty of (±10 ms); proxy times use one host clock. The offscreen frame arrived before the active frame on every Android trial. Web CDP observed the distinct preview and full active delta on the same connection.

The web replay waits for each active message to appear, then opens the offscreen Room and checks a unique suffix beyond the preview limit. That suffix is visible, proving a complete HTTP read rather than a truncated transcript cache. Android's final UI dump confirms the last active message is visible (`visibleLastMessage:true`). Before the final replay, the operator used the existing Jump to newest action: the screen had correctly preserved an older reading position and displayed a new-message count. Frame arrival is not claimed as native paint timing.

`web.json` and `android.json` hold the final samples. The matching `*-proxy-frames.json` files retain the proxy records used for the delivery column. IDs are disposable fixture message IDs. Earlier captures made while compiling Android were excluded from the final table; those measured additional backend/host scheduling time, not renewed network queueing.

## Build and compatibility

Android: actual Hermes/Fabric release APK, app version (0.2.22), build (27), x86_64, without DEBUGGABLE. SHA-256: `5b6cb9bc5769843e756d96a7f8606cbc3769d00eb8d4d829bfd70531257079d8`. Installed only on this corner's leased `buzzy_api36` emulator (`emulator-5554`). The local APK used generated development signing and cleartext permission for the disposable host proxy. No native source or release configuration changes are included in the PR.

The native APK contains the preview implementation atop base `13cdb1c8c`, plus temporary frame logging; it predates integration of unrelated upstream Workspace-refetch and push-outbox fixes. The final web export and final server include integrated main `9d948487f`. Preview behavior is the same; the final deletion fallback guard is additionally covered by the client/server regression suite. The temporary logging was removed from product source after bundling.

A client opts in with `sidebarPreviews:true` on subscribe. Older clients receive unchanged complete message deltas. Viewed Rooms also retain complete deltas; HTTP reads remain complete. The server validates preview projections before sending them. The client validates previews before dispatch, updates the sidebar, and never copies a preview into Room caches. Room titles/details still refresh through their existing invalidations; turn/corner state keeps its existing committed delta path. Mentions are server-resolved before shortening the text. Voice-card changes use a covering list read rather than a partial voice DTO.

Regression coverage includes omitted capability flags, viewed/offscreen transitions, deletion replacement, mention preservation beyond the text cap, unread/working state, push recovery, malformed previews, and separation from complete Room caches.

## Replay

Use the attached capture kit's isolated setup, read its scripts first, and substitute a fresh `beeline_latency_rig_transcript_*` loopback database. This run used `beeline_latency_rig_transcript_jellybean_hol`. Keep the fixture server on `23880`, the existing `scripts/latency-rig/proxy.mjs` on `23881`, and the release web server on `23882`. Export the web app with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:23881`. Its review login is the kit's disposable local-only fixture login, not a production account.

Run `replay-web.mjs` from this directory with `LATENCY_RIG_DATABASE_URL` set to that isolated database. It uses squire's existing Playwright/Chromium installation. The script writes `/tmp/jellybean-hol-web-results.json` and a full-open screenshot.

For Android, build the release app against `http://10.0.2.2:23881`, install only on the corner's leased emulator, and sign in with the kit's local review deep link. For frame measurement only, temporarily insert this logger in `LiveConnection` after parsing and validating the event, before `noteLiveFrame()`, then remove it after bundling:

```ts
console.info('[NET-HOL-1]', JSON.stringify({
  atMs: Date.now(), type: live.type,
  roomId: 'roomId' in live ? live.roomId : undefined,
  id: live.type === 'message-delta' ? live.message.id
    : live.type === 'sidebar-preview' ? live.preview.id : undefined,
  bytes: String(message.data).length,
}));
```

Set `LATENCY_RIG_DEVICE` to the verified corner emulator and run `replay-android.mjs` with the same isolated database URL. Ensure the Room is at newest before running if a prior visit preserved a historical reading position. The script reads the release app's frame log and verifies the final active message through UIAutomator; it writes `/tmp/jellybean-hol-android-results.json`. The original ASCII fixture makes logged string length equal payload bytes. Keep builds stopped during the measured trials and run platforms serially.

## Validation

After integration of main: root `npm run typecheck` passed; contract/server/replay tests passed (601 tests); mobile list, connection, and Room-session tests passed (161 tests). `npm run lint:workflow-paths`, replay-script syntax checks, and `git diff --check` passed. The release web export and Android release build passed.
