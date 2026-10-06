# Reproduction corner-history-scroll

Run `node proof/corner-history-scroll/run.mjs` from the repository root. Override host defaults with `PLAYWRIGHT_CORE_PATH` and `CHROMIUM_PATH` on another machine.

The script executes the shipped desktop anchor-capture callback and layout effect against actual browser DOM geometry. Read row m18 in a 60-row transcript, then test older-history loading alongside live work, removal of the oldest row alongside live work, live-only appends, a reader scroll before removal, and the pinned-tail guard.

Before the first fix: older-history plus live append moved m18 from 8px to -542px (-550px drift). The first fix passed that case but failed removal: 8px to -42px (-50px drift), as reported in review R1 and reproduced by the extended script.

After the visible-row fix: both cases keep m18 at 8px (zero drift). Live-only appends and reader scroll before removal also preserve their screen position. The pinned guard performs no history correction; existing tail-follow tests verify tail following.

The correction captures the top visible row on scroll and after each commit, then restores its screen offset in the next layout effect. Browser anchoring stays disabled so compensation runs once. This isolates the desktop history path; it is not a signed-in full-app or native-device reproduction.
