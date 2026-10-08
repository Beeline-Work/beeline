# Scroll controller on production web (step 2)

This PR's web build (`expo export --platform web`) was served locally against the production server (`server.usebeeline.app`), signed in through the `/review/<secret>` link as `@play-review`. Headless Chrome emulated a 390x844 phone, where the web app draws the phone FlatList. The same cases ran on `web.usebeeline.app` (`main`) as the baseline.

Room: `scroll-probe-2232` in the reviewer's "Empty screen test" Workspace, 60 messages, more posted during the runs. Positions are the row's top edge minus the list's top edge.

| Case | This PR | `main` (web.usebeeline.app) |
|---|---|---|
| New message while at newest (2 arrivals) | each arrival shown at the bottom, 36px above the list end | same |
| New message while scrolled up | reference row stays at 572px (before and after); disc shows | same (583px → 583px) |
| Jump-to-newest disc | arrival shown at the bottom, disc gone | same |
| Unread landing (message 10 of 60, cursor fixture) | message 10 on screen, 422px from the list top, from 2 s | message 10 on screen, 271px from the top |
| Notification landing (message 15) | 0px from the list top at 2 s and 6 s | same |
| Jump to message 5 with its read delayed 5 s, no drag (control) | 0px from the list top at 9 s | not run |
| Same jump, wheel scroll at 1.5 s | jump dropped: message 5 stays 2,217px above the list, the reader keeps the scrolled position | message 5 not drawn at 8 s; no landing seen either, so this run shows no difference on `main` |

Unread fixture: the reviewer is the only author in the probe Room, and a reader's own messages never count as unread. So the driver rewrote `viewer.readCursor` in the Room view response to say messages 10–60 are unread. Everything else is the live production response. On `main`, the PR runs and the baseline ran within the same hour. The "after deploy" confirmation on `web.usebeeline.app` is still to do after merge.

Files: `follow-after-arrivals`, `history-after-arrival`, `history-after-disc`, `unread-2s`, `notification-2s`, `slowjump-9s` (control), `dragjump-8s` from this PR; `main-*` from `web.usebeeline.app`.
