# Notification landing in a Room opened earlier (390x844)

Reproduction WARM-LANDING-1: open a Room, then tap a notification for a message in that Room's loaded rows but above the first screen. On `main` the target stays 1015 px above the list at 2 s and at 6 s.

## Setup

The production reviewer secret is not available to this corner. So the real server (`apps/server`, this branch) ran locally on PostgreSQL with its own `BEELINE_REVIEW_SECRET`. Headless Chrome at 390x844 signed in through `/review/<secret>` as the reviewer identity. At that width the web app draws the phone FlatList.

Two web builds (`expo export --platform web`) pointed at that server: `main` and this branch. They differ only in the three source files this PR changes.

Fixture: Room `scroll-probe` with 60 messages. The Room read returns messages 31–60. The target is message 38: it is in those rows, 22 rows above the newest, the same position as message 38 in the production `scroll-probe-2232` report. "Top" is the target row's top edge minus the list's top edge.

| Case | `main` at 2 s / 6 s | This branch (final head) at 2 s / 6 s |
|---|---|---|
| Cold open: the notification link is the first page | 0 px / 0 px | 0 px / 0 px |
| Room opened earlier: open the Room, go to the Room list, then load the notification link | -1015 px / -1015 px (rows 50–58 on screen) | 0 px / 0 px (rows 38–46) |
| Same Room open now: in-app navigation to the notification route | -1015 px / -1015 px | 0 px / 0 px |
| Second tap, new response key, same target (after the first tap and a scroll back to the newest rows) | -1015 px / -1015 px | 0 px / 0 px |

On the branch, these warm cases send no read around the target: message 38 is already loaded, so the store opens its window without a read.

## Production (`server.usebeeline.app`)

Signed in through the production `/review/<secret>` link as the reviewer, Chrome at 390x844, Room `scroll-probe-2232`, target message 38. `main` ran on `web.usebeeline.app`. This branch's web build (final head) was served locally against the production server (`--disable-web-security`, as in #2228 and #2234). Each build used one browser session for its four cases.

| Case | `main` run 1 | `main` runs 2 and 3 | This branch |
|---|---|---|---|
| Cold open | -184 px at 2 s and 6 s (rows 41–52) | 0 px | 0 px |
| Room opened earlier | 0 px | 0 px | 0 px |
| Same Room open now | 0 px | 0 px | 0 px |
| Same target, new response key | 0 px | 0 px | 0 px |

On production, `main` missed 1 of 12 case runs: a cold open whose read around the target answered before the Room's own rows (cause 2 in the PR). The warm misses in the step 3 report did not come back in these three runs, so they depend on timing there. On the local server the same `main` code misses every warm case (table above). This branch landed every case on both servers, and it sent no read around the target, because message 38 is already in the Room's rows. Files: `production/main-*-2s.png` (run 1) and `production/branch-*-2s.png`.

## Android (API 36 emulator, real tray notifications)

The dev-client APK loaded this branch's JS from Metro, then `main`'s JS (the three changed files swapped back), against the local server, signed in through `beeline://review/<secret>`. A local server cannot send FCM. So each tray notification was posted from inside the app with `expo-notifications` and the push payload (`type: message`, `channelId`, `messageId`, `workspaceId`), with the app in the background. Each notification was then tapped in the shade with `adb`. The app's foreground policy hides a notification for the Room that is open in the foreground, so "open now" means the Room screen stayed mounted while the app was in the background. The offset is the target row's top minus the list top, read from UI bounds.

| Case | `main` at 2 s / 6 s | This branch (final head) at 2 s / 6 s |
|---|---|---|
| Room opened earlier (another Room open when the tap arrives) | target off screen, rows 49–58 (2 of 2 runs) | 18 px / 18 px (2 of 2 runs) |
| Same Room open, at its newest rows | 74 px / 74 px (3 of 3) | 74 px / 74 px (2 of 2) |
| Second tap, same target, after a landing | 18 px / 18 px | 18 px / 18 px (2 of 2) |
| After a landing, the Room opened again without a notification, then a tap on the same target | target off screen, rows 39–49, no flash (2 of 4 runs; 2 of 3 on the branch before its last commit) | 74 px / 74 px (4 of 4) |

At 74 px the target is fully on screen and highlighted, with the last line of message 37 above it. Both builds do the same.

The last row is a separate miss, which the Android run found. Opening the Room again resets its window. The tap then opens a new store window in the same commit, but the list's last visibility report still showed message 38 from the old window. The controller settled the landing on that old report right after its first scroll, and that scroll used stale row positions. The controller now settles only on a report taken against the rows it is landing in. Files: `android/*.png` (`*-open-again-2s.png` for the last row).

## The "no Room request" run

The step 3 driver started a new browser and a new review sign-in for each case. The review exchange is rate limited per client: locally, 8 exchanges in a row succeeded and the rest got 429. A run whose sign-in gets 429 is signed out (`signed-out-rate-limited.png`, the GitHub sign-in screen) and sends no Room request; that run's network log shows only the page load. With one browser session for all cases, every run sends its Room read. That observation came from the test driver, not the app.

Files: `main-*-2s.png` and `branch-*-2s.png` (local server), taken 2 s after each tap.
