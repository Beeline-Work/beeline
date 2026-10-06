# Reproduction corner-history-scroll

Run `node proof/corner-history-scroll/run.mjs` from the repository root with the host Chromium and playwright-core paths shown in the script.

The script executes the shipped desktop prepend layout effect against actual browser DOM geometry. Read row m18 in a 60-row transcript, prepend ten older rows while appending live work, and compare that row's screen position.

Before: row moved from 8px to -542px, a -550px reading-position error. After: 8px to 8px, zero drift. This isolates the desktop history-loading path; it is not a signed-in full-app or native-device reproduction.

The correction measures displacement of the previous first row, excluding concurrent tail growth, and disables browser anchoring so compensation runs once. Existing tail-follow tests cover pinned following and reader escape.
