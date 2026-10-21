# Runnable artifact proof — 2026-10-20

This is a feature, not a defect report. Baseline `Reproduction HTML-GAME-1` used the built Body validator as a stand-in: posting an inline-script canvas game as ordinary `text/html` returned “a <script> element is not allowed.” The original user attachment and signed-in device were unavailable.

The replacement path was exercised with the actual new `RunnableArtifact` component, the actual server `serveRunnableArtifact` response, and a disposable fixture providing a fake capability and game bytes. No production account, credential, or Room write was used. This proves the renderer path; it is not a claim that a released app has posted or opened a game.

- [Android canvas play](android-play.png): tap increments the canvas game's score. The cookie/storage probes throw; API fetch is blocked by CSP.
- [Web canvas play](web-play.png): Score 1; cookies, localStorage, and parent DOM are all blocked, and the API fetch is blocked. Web uses the same component's iframe branch.
- [Android infinite loop with trusted counter](android-loop-counter.png): the renderer logged `RUNNABLE_LOOP_ENTERED` before the trusted counter changed to 1. The game was not reloaded by the counter rerender; only one loop-entry log was present. The same test initially exposed an attachment-dependency reload, which was corrected before this capture.
- [Android after Close](android-loop-closed.png): the trusted Close control unmounted the running game and returned to “Game closed,” with counter 1 retained.
- [Loop-entry log](loop-entered.txt): filtered Chromium console evidence for the final loop proof.
- [Web navigation gap](web-navigation-gap.png): actual frame URL `https://example.org/`, parent `http://127.0.0.1:18766/`. The game started from the production offline CSP response in an iframe with only `allow-scripts`. Scripted self-navigation succeeded. This is the baseline for `Reproduction HTML-GAME-NAV-1`; the accepted parent guard now tears the frame down after navigation.

Android: isolated leased `buzzy_api36` emulator, Android API 36, Chromium WebView 133.0.6943.137, existing Beeline debug native binary with this branch's JS fixture served through Metro. No native source/config/plugin changes or APK signing changes were made. The fixture's surrounding trusted controls are test controls, not a product UI redesign.

## Repeat

Run `npm run prove:runnable-server`. It serves only disposable game and loop bytes on loopback port 18764 using the real response policy. Put that server behind a disposable HTTPS tunnel; this is a proof origin, never the production game host.

For native, set `EXPO_PUBLIC_GAME_PROOF_ORIGIN` to that tunnel origin. Temporarily select `apps/mobile/scripts/runnable-native-proof.tsx` as the Expo entry in an isolated checkout, preserving and restoring `apps/mobile/index.ts`. Start Metro with two workers. Open the existing development client on a leased emulator. Play the canvas, then open the loop; wait for `RUNNABLE_LOOP_ENTERED` in logcat, increment the trusted counter, and close the game. Restore the entry afterward.

The same entry can be served as web through Expo for the canvas screenshot. The disposable fixture also serves the navigation probe under id `33333333-3333-4333-8333-333333333333`. It returns `<script>setTimeout(()=>location.href='https://example.org',1000)</script>` through `serveRunnableArtifact`; embed that URL in `<iframe sandbox="allow-scripts">` under a different host. Inspect the child frame URL after the timeout; the outside request demonstrates the accepted residual risk. For the guarded path use Test navigation or Test immediate navigation in the actual fixture viewer; the parent removes the resulting frame and offers Reopen.

Automated coverage: Body post_artifact opt-in and inert rejection; server MIME/capability/expiry verification and isolated host routing; proxy cookie/header stripping and fail-closed CSP checks; native prop/navigation/renderer-stop boundary; unchanged inert viewer regressions. The browser and emulator captures provide the visible result beyond those unit/integration checks.

## Parent navigation guard proof

`HTML-GAME-NAV-1` now passes the accepted behavior: [web-navigation-closed.png](web-navigation-closed.png) shows the parent-owned stopped state and Reopen, while Squire reports `frame_count: 1` (only the trusted parent remains). The outbound request to example.org still leaves the child before removal; Ruby accepted that residual risk. The frame holds no app session or data except user input into the game.

[web-immediate-navigation-closed.png](web-immediate-navigation-closed.png) repeats the proof with an immediate `location.href` in the authored script. The trusted initial shell delays all authored content until the parent has armed its first-load guard. The normal canvas game also ran through this initial shell and responded to a tap. Reopen was exercised and recreates the game; its next navigation returns to the same trusted state.

Android: [android-navigation-blocked.png](android-navigation-blocked.png) retains the original Navigation probe page and the trusted controls. [android-navigation-attempt.txt](android-navigation-attempt.txt) logs the attempted example.org navigation; [android-navigation-targets.json](android-navigation-targets.json), captured afterward through the existing debug WebView endpoint, shows its URL remained the original artifact origin. The trusted counter also updated to 1 after the rejected navigation.

The new web load/removal/reopen behavior and immediate-start gate are covered by component and server response tests. The TYPECHECK failure on the first PR head was the missing shared-component registry entry; the entry is now present, and the UI component policy passes without adding legacy-control exceptions. Backend or edge changes have not been rolled out before merge.
