# Notification landing on production (PR #2228)

This PR's web build (`expo export --platform web`) was served locally and ran against the production server (`server.usebeeline.app`). It was signed in through the `/review/<secret>` link as `@play-review`. Headless Chrome emulated a 390x844 phone. At that width the web app draws the inverted phone list, which is the same list the cover sat on.

Fixture: a test Room `landing-probe-2228` in the reviewer's "Empty screen test" Workspace, with 60 messages. Message 15 is a short target (35px). Message 20 is a 70-line target (2,174px, taller than the 722px list).

Each run opened `/beeline/chat/<room>?notificationMessageId=<id>&notificationResponseId=push:<id>` and sampled the page at 1, 2, 3, 5, 8 and 12 s. "Top" is the target row's top edge minus the list's top edge.

| Case | "Locating message" | Target top | Composer |
|---|---|---|---|
| Short target | never | 0px from 1 s | present |
| Tall target | never | 0px from 1 s | present |
| Short target, read around the target delayed 6 s | never | 0px from 2 s | present |
| Tall target, read delayed 6 s | never | 0px from 1 s | present |
| Deleted id (404) | never | n/a; "That message is no longer available" shows under the newest rows | present |

The same short-target run with the read delayed 6 s on `web.usebeeline.app` (`main`) showed "Locating message" at 1 s.

The screenshots were taken 2 s after opening. The target row has the brass landing highlight.
