# Notification landing in a Room opened earlier (390x844)

Reproduction WARM-LANDING-1: open a Room, then tap a notification for a message in that Room's loaded rows but above the first screen. On `main` the target stays 1015 px above the list at 2 s and at 6 s.

## Setup

The production reviewer secret is not available to this corner. So the real server (`apps/server`, this branch) ran locally on PostgreSQL with its own `BEELINE_REVIEW_SECRET`. Headless Chrome at 390x844 signed in through `/review/<secret>` as the reviewer identity. At that width the web app draws the phone FlatList.

Two web builds (`expo export --platform web`) pointed at that server: `main` and this branch. They differ only in the three source files this PR changes.

Fixture: Room `scroll-probe` with 60 messages. The Room read returns messages 31–60. The target is message 38: it is in those rows, 22 rows above the newest, the same position as message 38 in the production `scroll-probe-2232` report. "Top" is the target row's top edge minus the list's top edge.

| Case | `main` at 2 s / 6 s | This branch at 2 s / 6 s |
|---|---|---|
| Cold open: the notification link is the first page | 0 px / 0 px | 0 px / 0 px |
| Room opened earlier: open the Room, go to the Room list, then load the notification link | -1015 px / -1015 px (rows 50–58 on screen) | 0 px / 0 px (rows 38–46) |
| Same Room open now: in-app navigation to the notification route | -1015 px / -1015 px | 0 px / 0 px |
| Second tap, new response key, same target (after the first tap and a scroll back to the newest rows) | -1015 px / -1015 px | 0 px / 0 px |

On the branch, these warm cases send no read around the target: message 38 is already loaded, so the store opens its window without a read.

## The "no Room request" run

The step 3 driver started a new browser and a new review sign-in for each case. The review exchange is rate limited per client. Once it limits a run, that run is signed out (`signed-out-rate-limited.png`, the GitHub sign-in screen) and sends no Room request at all. The local server logged `[review-access] rate-limited client=127.0.0.1` during those runs. When all cases ran in one browser session, every run sent its Room read. That observation came from the test driver, not the app.

Files: `main-*-2s.png` and `branch-*-2s.png`, taken 2 s after each tap.
