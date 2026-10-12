# Browser viewer round 4

Native proof on a disposable `viewer_composer_api36` emulator, launched read-only on port 5570. Screen: 1080 × 2400, density 420 dpi. No other emulator or shared helper was driven.

Both APKs use the Hermes **release** variant with a local development signing key, an isolated `cu4-proof` OTA channel and a loopback test API (`10.0.2.2`). They are not store or production artifacts. The real app enters an isolated Beeline Review Workspace through its `/review/` deep link. The proxy uses the real server, PhoneService, TokenAuth, viewer authorization and Squire WebSocket handlers backed by PGlite. TikTok is a real Squire page, 1280 pixels wide. The two captures show different rotating TikTok hero panels.

| Requirement | Before | After |
|---|---|---|
| Viewer activity stays out of the Room | [Room](android-before-room-open-close.png): two `A person` system lines | [Room](android-after-room-open-close.png): no browser activity lines |
| Opening and closing never wakes an agent | [Database facts](facts-before.json): two pending `subscribed_event` commands | [Database facts](facts-after.json): zero commands; actual viewer named in agent-only context |
| Composer above keyboard | [Viewer](android-before-viewer.png): gap was about 10 dp on this rig | [Viewer](android-after-viewer.png): explicit 12 dp gap, both above navigation |
| Page fills viewport | [Viewer](android-before-viewer.png): canvas bounds y=892–1690 inside viewer y=304–2276 | [Viewer](android-after-viewer.png): canvas bounds y=309–2277, filling viewer y=309–2277 from top-left |
| Only requested top controls | [Viewer](android-before-viewer.png): Open, Hand back, End share, close | [Viewer](android-after-viewer.png): Open and close in their own row above the page |

The reported overlap was not reproduced on this emulator. Its before frame already had a small gap; the implementation now defines the gap and prevents the embedded WebView from applying a second bottom safe-area inset. The approved `computer-collapsed` board was absent from this worktree; the implementation follows the brief's explicit vertical stack.

Filling uses uniform cover scaling rather than stretching: a desktop page is cropped horizontally in portrait. A native horizontal swipe pans the crop ([after pan](android-after-pan.png)) without creating an agent command. Vertical dragging scrolls the remote page; pinch zoom retains its focal point in the existing gesture code. Pinch execution was not verified; firstmate authorized shipping the Android evidence after the shared chrome-devtools-axi session failed.

Activity observations use hidden `activity` rows with no durable fact. Passive open/close/takeover observations carry no wake targets and become context on the next requested Room turn. Meaningful input/navigation while in human control still uses the dependency's coalescing path. A migration hides old lines and cancels pending passive-only commands while preserving meaningful coalesced input. Hand back and End share controls are removed from the native and standalone viewers; closing only disconnects the viewer and leaves the session live.

## Checks

After rebasing onto the dependency: 125 related server tests, 117 helper tests and 30 mobile tests passed. The final computer-session/live-delta and system-line tests passed again (15 tests) after the last test changes. Server, helper and mobile type checks passed. Both the bundle and APK were rebuilt from the combined branch, and the after frames were refreshed.

Coverage includes passive open/close without commands, actual viewer naming with no handle, next-turn context, hidden phone transcript rows, historical cleanup, explicit close without control writes, frame relay/access/expiry, and source grammar enforcement.

No live model helper was started. The no-wake claim is verified at the authoritative command store rather than by observing model behavior. No captain Workspace, live helper, shared no-mistakes daemon or shared Squire broker was restarted or updated.

Final local release APK SHA-256: `3a392163364392d34c865c8a252248604e5e867ede755e1efb7888c28ec6a60d`.
