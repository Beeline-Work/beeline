# Reply recovery

Reproduction `reply-hidden-until-next-send` uses the deterministic failure class authorized in brief revision 2. The incident's lost frame cannot be attributed to a particular layer: Fly logs show the 13:49:08 UTC write, then the owner's 13:50:22 send and 13:50:24 Room GET; no delivery error appears. Sentry has no events in 13:45–13:53 UTC. The test reproduces the client recovery defect, not the original network failure.

Before implementation, both added session tests failed against unchanged main source (also identical to origin/main for these session/transport files): after 14 seconds the last painted message remained `m-2042`, not `hidden-reply`. Both now pass: one stores a long reply plus completed turn behind a silent connection, the other fails the first catch-up GET. Neither sends a human message.

## Visible demonstration

Run `node apps/mobile/scripts/reply-recovery-proof.mjs`, then open `http://localhost:8746/?case=normal` or `?case=retry` in a fresh browser page. The script bundles the actual Room session, reconciler and scheduler. Network/storage/auth edges and the minimal transcript renderer are fixtures. A real WebSocket sends the subscribed frame and then stays silent. The HTTP fixture stores a 2.5 KB reply and completed activity after 100 ms; the retry case returns one 503. No input or send operation exists in the proof.

Desktop Chrome showed Working before recovery, then Finished and the long reply at 8.004 seconds from the initial GET; the failed-read case completed at 9.005 seconds. The diagnostic contained Room id, last frame timestamp, socket state 1 and silence duration, with no message contents. Screenshots: [web](web.png), [Android Chrome](android-chrome.png).

The same bundle rendered on an Android 36 emulator through Chrome (`10.0.2.2:8746`); its catch-up completed at 8.005 seconds. **This is an Android browser stand-in, not native Beeline app proof.**

Production `web.usebeeline.app` opened through Trusty Squire in an existing lunchboxfortwo owner session. Connectors confirmed the reviewer bypass exists as a sealed login-link credential. The mounted browser navigation tool accepts only a plaintext URL; no sealed-link navigation operation is exposed. No secret was fetched. Reviewer-bypass proof and native Beeline app proof remain outstanding; this branch was not deployed and no release was dispatched.

## Request cost

An open foreground Room showing a committed working turn reads at 8 seconds of silence, then backs off to 12-second intervals: 5 additional Room GETs in the first silent minute and 5/minute thereafter. Each GET returns messages and activity together. Intermittent Room frames reset the deadline to 8 seconds (worst sustained rate 7.5/minute). A healthy Room receiving frames less than 8 seconds apart adds zero GETs. Nothing missing still costs these same reads while working remains committed; unchanged projections retain structural sharing. Idle, unfocused and background Rooms add no recovery GETs. Terminal activity cancels the timer. Each failed refresh gets at most three immediate retries at 1/2/4 seconds, then only the working-turn watchdog remains. No parallel reads are introduced.

## Read marks

The 13:50:25 markRead error identifies neither the submitted message id nor its client row, so its exact cause cannot be proven. The viewport could nominate provisional activity/draft/turn ids even though markRead accepts only stored messages; these rows are now excluded and covered by a regression. Durable folded message ids keep their existing ordering. No server membership or authorization checks changed.
