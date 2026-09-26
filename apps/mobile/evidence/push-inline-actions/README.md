# Inline notification actions evidence

## Setup

- A release build (`assembleRelease`, JS bundle embedded, not a dev client) of
  this branch, signed with a throwaway key because the sideload key lives only in
  repository secrets, and pointed at a local server with
  `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:8796`.
- A dedicated Android 16 (API 36, Google APIs) emulator. The shared release-proof
  emulator was not touched.
- The server from this branch on a throwaway PostgreSQL, sending pushes through
  real FCM for the app's Firebase project.
- Signed in with the reviewer link (`beeline://review/<secret>`). A fixture wrote
  an agent `@wren`, owned by the reviewer, and either a real grant-request card
  (written by the server's own `systemLine`, landing in the reviewer's @system
  DM) or an agent message tagging `@play-review` in a Room.

"App killed" means the app was launched, sent home, and its process killed with
`am kill` (what swiping it away or the system reclaiming memory does). It does not
mean `am force-stop`, which puts an app in Android's stopped state. Android
delivers no FCM message to a stopped app. An incoming push starts a background
process (no screen) to draw the notification. For **Once** that background process
was still alive at the tap. For **Always**, **No** and every reply it was killed
again after the notification appeared, and `pidof app.usebeeline` was empty at
the tap. So the tap started a new process, and the action ran headless.

## Demonstrated

| Screenshot | What it shows | Server state afterwards |
| --- | --- | --- |
| `01-grant-expanded-app-killed.png` | Grant notification expanded: No · Once · Always | grant `pending` |
| `02-grant-once-allowed.png` | Tapped **Once**: rewritten in place, header `Allowed once`, buttons gone, app not opened | `agent_grants.status = once` |
| `03-grant-always-allowed.png` | Tapped **Always** (process dead at tap): `Always allowed`; the earlier outcome sits quietly under Silent | `approved` |
| `04-grant-no-denied.png` | Tapped **No** (process dead at tap): `Denied` | `denied` |
| `05-reply-typing-app-killed.png` | Tag from Wren, Reply field open in the shade, process dead | — |
| `06-reply-replied.png` | Sent: `Replied`, with `You: On it, pushing a fix now` | message in `#proof` by `play-review`, `reply_to_message_id` = the tagging message |
| `07-reply-failed-server-down.png` | Server stopped before sending: `Couldn't send · tap to open`, Reply kept | no message |
| `08-reply-retry-from-failure.png` | Server back, Reply from the same failed notification: `Replied` | message posted as a reply |
| `09-failed-reply-tap-opens-room-prefilled.png` | Tapping a failed reply's notification opens `#proof` with the typed text in the composer | — |

The unit tests cover the paths not captured here: an already-answered grant
(the server returns 409) shows `Already answered · tap to open`, and the iOS
outcome copy.

## Not verified here

iOS. This Linux host has no iOS simulator. The iOS behaviour covered by unit
tests: the category order `Always, Once, No`, `No` destructive, every action
requiring device authentication, the APNs `category` field, and quiet (passive)
outcome notifications. What is NOT covered: that iOS launches a killed app for a
background action and that the JS answers before iOS suspends it.
