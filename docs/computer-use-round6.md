# Computer use round 6: Android stream handoff

The native card now mounts one full-size WebView while the card is visible. Opening the viewer reveals that same WebView and switches its socket from preview to interactive mode. Closing switches it back. The existing card preview continues to stream; neither the WebView URL nor its React instance changes during an open/close cycle. The server refuses input from the warm socket until it is interactive.

## Device-clock proof

An isolated release build ran on emulator-5578 (`-read-only`). A local Beeline Review fixture supplied an agent-owned Chromium tab and a Squire-protocol page with alternating JPEG frames. The scratch `ProofTouch` injector printed `System.currentTimeMillis()` immediately before `ACTION_DOWN`. Android `screenrecord --bugreport` stamped the displayed frames with the device clock. Five taps per source were read from the recording, including the first Squire full-view opening. “Live” is the first recorded change in the page clock (Chromium) or alternating JPEG (Squire) after the full view appears. Times are seconds after the tap.

| Sample | Chromium full | Chromium live | Squire full | Squire live |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.100 | 0.255 | 0.187 | 0.319 |
| 2 | 0.132 | 0.253 | 0.091 | 0.200 |
| 3 | 0.108 | 0.215 | 0.126 | 0.254 |
| 4 | 0.114 | 0.196 | 0.101 | 0.228 |
| 5 | 0.171 | 0.224 | 0.101 | 0.268 |

The recordings show no black or loading frame between the first full frame and the continuing stream. These measurements exercise the Beeline Android viewer and a Squire-compatible local stream; a production Squire run remains necessary to confirm the upstream service under load.

## Fresh Squire card limit

The v0.1.32 production proof measured a fresh Squire `share_browser` call at 4.449 s and card creation at 4.386 s after call start; later shares took about 0.26–0.32 s. The round-6 isolated trace placed about 4.2 s of a fresh call inside the awaited upstream `operate_share`. In `apps/body/src/read-only-mcp.ts`, `shareBrowser` can call `postComputerSession` only after `squireShareEndpoint` returns a live URL and expiry. Beeline cannot display a live Squire card before that response. The native stream fix shortens card opening but does not meet the three-second *fresh share-to-card* target; Squire's first `operate_share` setup needs to complete sooner.

The URL fix is verified by `apps/server/src/computer-session.test.ts`: a form-navigation notification is followed through the real command claim and final prompt assembly, which must contain the full destination URL.
