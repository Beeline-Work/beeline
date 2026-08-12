# Room clean chat and Corner TUI evidence

Captured from the signed `app.buzzy.mobile` release APK on Android API 36 (`emulator-5554`). The release package was run against the relay-backed `Corners UX Review` fixture.

## On-device screens

- [Room](./room-after.png): conversational bubble plus the single compact Corner status card. The header clears the status bar, the member action is a bare `+`, the own-message label has no diamond, `working…` sits above the composer, and `Message` stays on one line.
- [Corner](./corner-after.png): review controls followed by separately formatted output, thinking, collapsed tool calls, and final output. Tool rows are tappable and the terminal copy wraps normally.

## GrokNight comparison

- [Room beside GrokNight A](./room-v-reference.png)
- [Corner beside GrokNight A](./corner-v-reference.png)
- [Full approved reference board](./reference-board.png)

The implementation follows the current mobile GrokNight token authority in `sources/buzz/groknight.ts`: black/gunmetal surfaces, machined-steel borders, and grayscale state. The historical board still shows chromatic syntax and status accents; those are intentionally absent because the approved mobile system forbids chromatic state. The Corner also reserves its upper area for the real change-review controls, so its transcript begins lower than the static reference mock.
