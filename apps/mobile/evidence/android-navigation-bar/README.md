# Android navigation bar matches the app

Release APKs (x86_64, debug-signed) built from main 46ffa1629 (before) and this
branch (after), run on an Android 15 emulator switched to 3-button navigation,
on the sign-in screen.

Pixel at x=100 in the app body (y=2000) and in the navigation bar (y=2340), 1080x2400 capture:

| Capture | App | Bar | Home button |
| --- | --- | --- | --- |
| before-bone | 243,238,228 | 254,253,252 | 69,70,79 |
| before-obsidian | 20,9,26 | 23,18,31 | 197,198,208 |
| after-bone | 243,238,228 | 243,238,228 | 69,70,79 |
| after-obsidian | 20,9,26 | 20,9,26 | 197,198,208 |

after-obsidian is a cold start in dark mode; after-bone is the same running app
after the system switched to light mode, so it also covers the live theme change.
