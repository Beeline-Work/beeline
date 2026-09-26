# GitHub sign-in with no network — before and after

Real Android emulator frames (API 36, airplane mode on) of the onboarding
screen (`apps/mobile/sources/app/(app)/beeline/onboarding.tsx`). Both builds
are the `app.usebeeline.harness` APK with a JS bundle embedded from this
repository and pointed at production `https://server.usebeeline.app`: "before"
from `main` at `bb17842cd`, "after" from the fix commit. Nothing else differs.

| File                                      | What it shows                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before-1-browser-no-internet.png`        | Tapping Continue with GitHub offline opens the browser onto Chrome's own "No internet" page                                                        |
| `before-2-spinning-offline.png`           | Closing it leaves the button spinning while the app polls a server it cannot reach                                                                 |
| `before-3-session-expired-after-2min.png` | About two minutes later: SESSION EXPIRED, which blames the proof, not the connection                                                               |
| `before-4-every-retap-bind-failed.png`    | Every later tap flips logging-in → normal at once with BIND FAILED · UNKNOWN / Network request failed (the unrevocable recovery token fails first) |
| `after-1-no-connection.png`               | About a second after the offline tap: NO CONNECTION notice and one Try again button; no browser opens                                              |
| `after-2-still-holding-80s-later.png`     | 80+ seconds later the screen has not changed: nothing retries on its own                                                                           |
| `after-3-network-back-untouched.png`      | Network restored, not tapped: the screen still waits for the person                                                                                |
| `after-4-try-again-reaches-github.png`    | Try again with the network back opens GitHub's real sign-in page for Beeline App                                                                   |

Completing the GitHub login itself needs a person to sign in on the page in
`after-4`; the rig never scripts GitHub credentials.
