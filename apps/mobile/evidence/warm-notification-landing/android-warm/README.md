# Warm-Room tray taps on Android (API 36 emulator)

Reproduction F2 (from the deleted-message-landing corner): open a Room so its rows are cached, go back, let newer messages arrive, then tap a tray notification for a message 20 or more rows back. On `main` the list stays at the cached newest rows or stops just above the target, with no highlight.

## Setup

- `buzzy_api36` emulator, one instance, software GPU. The dev-client APK loads JS from Metro. The local server and Postgres run on the host, and the app signs in through `beeline://review/<secret>`.
- Room `#scroll-probe` holds 60 probe messages, plus 5 newer messages per run.
- Each run does the following:
  1. Open the Room, then press back. The Room screen stays cached.
  2. Send 5 messages from the server. For a deleted target, delete the target.
  3. Press HOME.
  4. The app posts a local notification with the push payload (`type: message`, `channelId`, `messageId`, `workspaceId`), because a local server cannot send FCM.
  5. Open the shade and tap the notification with `adb`.
- The screen is recorded for 12 s. The offset is the target's text top minus the list top (y=294), read from UI bounds at 4 s and 6 s after the tap. The highlight is detected from the recording: a row filled with the flash tint (210,198,173) with its top within 40 px of the list top.
- Metro does not pick up file edits in this worktree. It was restarted with `--clear` for each build, and the loaded controller was checked in the app runtime before each set of runs.

## Results

| Build | Target | Lands on screen | Highlighted |
|---|---|---|---|
| `main` | live 48 | no: newest rows at 4 s and 6 s (`main-live-48-end.png`) | no |
| `main` | deleted 49 | no: newest rows (`main-deleted-49-end.png`) | no |
| `main` | deleted 50 | no: newest rows (`main-deleted-50-end.png`) | no |
| `main` | live 47 | yes, 18 px | yes |
| branch | deleted 38, 39, 41, 42 | 4 of 4, deletion line at 13 px by 4 s | 4 of 4, at the top, 3.0 to 3.6 s after the tap |
| branch | live 43, 44, 45, 46 | 4 of 4, at the top by 4 s (43 at 139 px is its text under the author header; the row starts at the top) | 4 of 4, at the top, 2.9 to 4.1 s after the tap |

Files: `branch-*-flash.png` show the flashed row at the top of the list. `main-*-end.png` show the last recorded frame (about 10 s after the tap).

The emulator is slow: the app takes about 2.5 s to route a tray tap before the Room screen mounts. Every branch landing flashed between 2.9 and 4.1 s after the shade closed.

## What the logs showed

Temporary logs on the branch showed a fourth cause on the device. While the read around the target was out, Android called `onMomentumScrollBegin` with no drag before it. The controller took that as the reader taking the list. It cancelled the landing, and the cancel dropped the read. The read answered about a second later and was discarded. With that fixed, every logged run read the page, scrolled to the row, and landed.
