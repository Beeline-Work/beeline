# Web composer dictation

This is feature work: Beeline originally connected speech recognition only on
iOS and Android. The web adapter now uses expo-speech-recognition's browser
implementation and its capability check. Recognition starts only on a mic tap;
the browser owns the permission prompt. Native permission and recording behavior
are unchanged. Web long-press conversational mode is a separate follow-up PR.

## Browser demonstration

Run from the repository root:

```sh
npm run test --prefix apps/mobile -- --run sources/components/buzz/ConversationComposer.web-dictation.browser.test.ts --maxWorkers=1
```

The test bundles and renders ConversationComposer in headless Chrome at 390 px.
Expo's speech module, event conversion, Beeline's web adapter, speech hook, and
composer are real. The browser recognition engine is scripted at the Web Speech
API boundary, and Expo's registry plus unrelated device/session dependencies are
stubbed. Both `webkitSpeechRecognition` and `SpeechRecognition` paths print
`RESULT PASS` for:

- Opening the composer without starting capture.
- Showing the mic, then starting capture once on tap.
- Handling interim and final browser results.
- Stopping capture and sending the committed transcript.
- Permission denial with browser site-settings guidance and a retry on tap.
- A transient network error with one restart on `end`.
- Discarding a take without sending its words.

With neither browser API, the proof prints `RESULT PASS` for hiding the mic and
keeping the send control. The native adapter, shared speech-hook tests, composer
speech/trailing-control tests, design lints, root typecheck, and UI component
policy also pass.

## Verification limits

Verified in a real headless Chrome renderer with scripted recognition events.
No real phone, BrowserStack session, microphone permission prompt, spoken audio,
or Google server transcription was verified. These tests prove integration and
UI behavior, not recognition accuracy or service availability. An API being
present does not guarantee its backend works in every Chromium-derived browser.
