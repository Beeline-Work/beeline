# Scrubber and short-list fill on production web (step 3)

This PR's web build (`expo export --platform web`) was served locally against the production server (`server.usebeeline.app`). It was signed in through the `/review/<secret>` link as `@play-review`. Headless Chrome emulated a 390x844 phone, where the web app draws the phone FlatList and the scrubber. The same driver ran on `web.usebeeline.app` (`main`) as the baseline, within the same hour.

Rooms: `scroll-probe-2232` (60 probe messages) and `short-probe-2234` (3 messages) in the reviewer's "Empty screen test" Workspace. The scrubber was dragged with mouse events on `transcript-scrubber-grab`. Web has no momentum events, so "fling" is a fast burst of six wheel events with the scrubber grabbed right after it. "Rows" are the probe message numbers on screen.

| Case | This PR | `main` |
|---|---|---|
| Scrub and release (bar dragged 150px up from scrollTop 600) | scrollTop 1202, rows 31–44 at release, 100 ms later and 2 s later | same |
| Scrub after a fling | scrollTop 1802, rows 21–34 at release, 100 ms later and 2 s later | same |
| Scrub held at the top | message 1 on screen; each older-history request asks for a different page (1 or 2 requests across runs) | message 1 on screen after 4 s; 2 identical older-history requests |
| Short room (3 messages) | all 3 rows and "Beginning of Room" at 3 s and 10 s; 1 history request | same rows; 2 identical history requests |
| Notification landing (message 38), fresh session | 0px from the list top at 2 s and 6 s | same |
| Jump-to-newest disc after scrolling up (scrollTop 1013–1500 across runs) | rows 52–60, scrollTop 0, disc gone | same |

The PR rows come from the final head, where the scrubber reads positions from the Room message store (`positions`). Notification landing also ran in a session that had opened the Room before. There the target was not on screen at 6 s on both builds. This PR does not change that path.

Files: `scrub-release`, `scrub-after-fling`, `scrub-top`, `short-room`, `notification-2s`, `jump-button` from this PR; `main-*` from `web.usebeeline.app`. The "after deploy" check on `web.usebeeline.app` is still to do after merge.
