# Google Play review access — rig proof

Screenshots from the end-to-end run on a second AVD (`se_api35_b`, emulator-5556).
The canary on emulator-5554 was not touched: it still reports versionCode 39,
versionName 0.2.18 and `lastUpdateTime 2026-09-02`, and the APK build ran with
`BEELINE_ANDROID_KEEP_DEVICE=1` so its teardown never reached that device.

| file | what it shows |
|---|---|
| `e2e-1-landed.png` | The app after the review link was opened from a signed-out device: `#welcome` with real history, the `play-review joined` line, and the welcome agent's greeting. |
| `e2e-3-typed.png` | The reviewer typing an ordinary message in the composer. |
| `e2e-5-reply.png` | The greeting addressed by name (`Welcome, @play-review!`), the reviewer's message, and the agent's reply. |

Timing, measured on that run:

- link tapped -> app in front, signed in: **18.8s** (cold start of a freshly installed app)
- link tapped -> the welcome agent's greeting posted: **7.4s**
- reviewer's message -> agent's reply: **3s** (14:43:45 -> 14:43:48 in the Room)
