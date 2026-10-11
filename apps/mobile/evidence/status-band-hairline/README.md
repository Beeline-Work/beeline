# Status band and composer surface

Captured in the **Beeline Review** Workspace, in its `#proof` Room. The status fixtures supply “Waiting for @ruby”, a working line, or no line locally; they dispatch no agent commands. The temporary fixture changes are absent from the PR.

Android frames use `assembleRelease -PreactNativeArchitectures=x86_64` on the task’s `buzzy_api36` instance started with `-read-only -port 5562`, with three-button navigation. The emulator-only APK uses the generated debug signing key; JavaScript runs in release mode. OTA loading was disabled in the generated, uncommitted Android manifest to keep the capture on the built source. Review sign-in used the `/review/` deep link. Native Room reads intermittently timed out; firstmate approved using the saved Review response for this layout check. No timeout behavior was changed.

The transcript was scrolled behind the status band in every frame. Before, the full-width composer border is visible below the status line. After, the shared stack is opaque and drawn above the transcript, and the existing 1px edge is painted in that same canvas color. Android’s former-border strip (x=0..1079, y=2113..2133) is entirely the theme canvas in all six after scenarios. The line remains an absolute overlay; it still adds no height when it appears.

Web frames use `chrome-devtools-axi` in a separate browser session, at 412×915 and 1440×915. The local dev bundle was rebuilt after editing. [Before/after DOM measurements](web-geometry.json) verify the same stack and status-slot bounds in all twelve scenarios; the composer keeps its 8px padding and 1px edge, with that edge painted in the canvas color.

| Surface | Status | Before | After |
| --- | --- | --- | --- |
| Android release, light | waiting | [Before](android-before-waiting-light-scroll.png) | [After](android-after-waiting-light-scroll.png) |
| Android release, light | working | [Before](android-before-working-light-scroll.png) | [After](android-after-working-light-scroll.png) |
| Android release, light | idle | [Before](android-before-idle-light-scroll.png) | [After](android-after-idle-light-scroll.png) |
| Android release, dark | waiting | [Before](android-before-waiting-dark-scroll.png) | [After](android-after-waiting-dark-scroll.png) |
| Android release, dark | working | [Before](android-before-working-dark-scroll.png) | [After](android-after-working-dark-scroll.png) |
| Android release, dark | idle | [Before](android-before-idle-dark-scroll.png) | [After](android-after-idle-dark-scroll.png) |
| Web phone width, light | waiting | [Before](web-before-waiting-light-mobile.png) | [After](web-after-waiting-light-mobile.png) |
| Web phone width, light | working | [Before](web-before-working-light-mobile.png) | [After](web-after-working-light-mobile.png) |
| Web phone width, light | idle | [Before](web-before-idle-light-mobile.png) | [After](web-after-idle-light-mobile.png) |
| Web phone width, dark | waiting | [Before](web-before-waiting-dark-mobile.png) | [After](web-after-waiting-dark-mobile.png) |
| Web phone width, dark | working | [Before](web-before-working-dark-mobile.png) | [After](web-after-working-dark-mobile.png) |
| Web phone width, dark | idle | [Before](web-before-idle-dark-mobile.png) | [After](web-after-idle-dark-mobile.png) |
| Web desktop, light | waiting | [Before](web-before-waiting-light-desktop.png) | [After](web-after-waiting-light-desktop.png) |
| Web desktop, light | working | [Before](web-before-working-light-desktop.png) | [After](web-after-working-light-desktop.png) |
| Web desktop, light | idle | [Before](web-before-idle-light-desktop.png) | [After](web-after-idle-light-desktop.png) |
| Web desktop, dark | waiting | [Before](web-before-waiting-dark-desktop.png) | [After](web-after-waiting-dark-desktop.png) |
| Web desktop, dark | working | [Before](web-before-working-dark-desktop.png) | [After](web-after-working-dark-desktop.png) |
| Web desktop, dark | idle | [Before](web-before-idle-dark-desktop.png) | [After](web-after-idle-dark-desktop.png) |

[Android waiting line with keyboard open](android-after-waiting-light-keyboard.png) additionally checks the surface above the keyboard and three-button navigation.

Validation: 67 focused layout, scroll-follow, turn-line, composer-layout, Room-open geometry and design-lint tests pass. The theme surface checks fail against the original styles and pass with the fix. Mobile typecheck passes after rebuilding the workspace package declarations. A final release build also succeeds with the temporary status fixtures removed; [its ordinary Review Room frame](android-final-review-light.png) has no synthetic status.
