# Desktop dictation in WebKit

Reproduction desktop-dictation-webkit: on base
`a37868e86eaaced940d95b4d0c2d5bf9674ffff0`, the rendered composer in
Playwright WebKit 26.5 has no mic when both Web Speech constructors are absent.
`AudioContext` and capture are available; opening the composer requests no mic.
The baseline run with `--reproduce` confirmed `micVisible: false`.

The fallback records mono PCM using Web Audio, closes WAV pieces every 30 seconds,
and uses the existing dictation uploader, ADPCM compression, authenticated
transcription endpoint, retry/deadline handling and Room lexicon prompt. The mic
requests echo cancellation. Silence ends capture; a take also ends at five
minutes. A Web Speech implementation always takes precedence.

## Repeat the proof

From the repository root, prepare workspace dependencies and builds:

```sh
npm ci --ignore-scripts
npm run corner:prepare
npm install --prefix /var/tmp/beeline-webkit-proof playwright@1.61.1 --ignore-scripts
node /var/tmp/beeline-webkit-proof/node_modules/playwright/cli.js install webkit
BEELINE_PLAYWRIGHT_MODULE=/var/tmp/beeline-webkit-proof/node_modules/playwright/index.mjs node --experimental-strip-types apps/mobile/scripts/prove-server-dictation.mjs
```

Playwright uses its configured browser cache; set `PLAYWRIGHT_BROWSERS_PATH` for
both install and proof when using a separate cache. No production lifecycle,
account credentials or provider key are used. The proof uses ephemeral loopback
ports and closes its servers and browser.

For the original failure, add `--reproduce`. That mode loads the pinned baseline
adapter from Git and renders it against the same composer; the normal run uses
the current adapter.

## What is real

The WebKit renderer, composer, web adapter, speech hook, audio graph and PCM
capture callbacks, WAV encoding, blob reads, ADPCM uploader, HTTP request,
server transcription route and SpeechTranscriber multipart construction are
real. The proof captures an oscillator through a MediaStream, then feeds silence.
The provider boundary verifies nonempty audio, language and Room prompt. Text
returns to the editable composer and is sent through its Send control. A second
take verifies explicit stop and dictated send. Capture
tracks end and browser recording URLs are released.

The physical microphone is replaced with generated audio. A test identity and
session transport replace sign-in; the server still applies its bearer auth
path. Groq's response is a fixture. Other device/session/Expo registry shims are
listed in the proof script. Composer focus is fixed as in the existing browser
fixtures. This proves integration, not acoustic accuracy, live provider access,
OS permission dialogs, or a native Tauri executable. ScriptProcessorNode is
used for WebKit compatibility, including engines without MediaRecorder codecs;
its output buffer is silent and never plays microphone samples.

## Validation

The focused speech/recorder/transcription/native-adapter/browser suite passes
86 tests. The composer speech/trailing-control and design suites pass 77 tests.
Root typecheck, UI component policy and dead-code validation pass.

```sh
npm run test --prefix apps/mobile -- --run sources/buzz/speech-input.test.ts sources/buzz/speech-transcription.test.ts sources/buzz/speech-recognition-adapter.test.ts sources/buzz/speech-recognition-adapter.web.test.ts sources/buzz/speech-recorder.web.test.ts sources/buzz/speech-dictation-path.test.ts sources/components/buzz/ConversationComposer.dictation.browser.test.ts sources/components/buzz/ConversationComposer.web-dictation.browser.test.ts --maxWorkers=1
npm run typecheck
npm run lint:ui-components
npm run dead-code
```

The existing unsupported-browser fixture now explicitly lacks both recognition
and capture. Prefixed and standard Web Speech still exercise their original
recognition path even when capture is available.

## Integration

The separately assigned #2450 currently contains overlapping recorder changes
alongside Tauri shell permissions and cross-origin transcription headers. Those
recorder changes must be reconciled with this separate dictation PR before
landing both. This proof uses a same-origin proxy to a real local server; it does
not establish production cross-origin permissions or native shell microphone
entitlements.
