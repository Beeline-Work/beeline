# Desktop dictation in WebKit

Reproduction desktop-dictation-webkit: on base
`a37868e86eaaced940d95b4d0c2d5bf9674ffff0`, the rendered composer in
Playwright WebKit 26.5 has no mic when both Web Speech constructors are absent.
`AudioContext` and capture are available; opening the composer requests no mic.
The baseline run with `--reproduce` confirmed `micVisible: false`.

The implementation landed in #2450 at
`a36a02385fd04604acf39f2ca725b5b55c0ed2fe`. This proof is replayed against that
implementation; this PR retains no production speech source or test changes.
The fallback records mono PCM using Web Audio, encodes 16 kHz WAV pieces after
eight seconds at a quiet frame or at thirty seconds without a pause, and uses
the existing uploader, ADPCM compression, authenticated transcription endpoint,
retry/deadline handling and Room lexicon prompt. The mic requests echo
cancellation. Silence ends capture. Web Speech takes precedence outside Tauri;
the desktop shell uses recording for server transcription.

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

`demonstrated.txt` records the replay against #2450's merged product source.
`reproduced.txt` records the original missing mic on the pinned baseline.
The original implementation and evidence remain recoverable at
`8281ccb82585a9721b50b73a53678f9d023291e3`.

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

#2450 owns the recorder, adapter, speech hook, transcription, server CORS and
Tauri microphone permissions. This proof uses a same-origin proxy to a real
local server; it does not establish production cross-origin permissions or
native shell microphone entitlements. The previously delivered Conversation
artifact remains pinned to `324d951ea0cbbcc0ecfe8da5ec8616d379e6ee71`, with
generated/provider fixtures and its native Tauri dependency blocker unchanged.
