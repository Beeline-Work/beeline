# Desktop Conversation entry

Reproduction desktop-voice-gate-1: open the shipped composer at 1280px in
Chrome, hold its existing mic and release. On the original implementation,
the platform condition removes the long-press handler: Conversation never
opens and the release starts dictation. The browser regression prints FAIL
for entry, dictation suppression and exit. The renderer regression separately
fails with `mic.props.onLongPress is not a function` on web; Android and iOS pass.

After removing only the web platform condition, Chrome prints:

```text
PASS desktop composer shows the existing mic
PASS Reproduction desktop-voice-gate-1: holding enters Conversation once
PASS release does not start dictation
PASS existing End control returns to composer
RTC and providers are stubbed; this proves entry and exit only.
RESULT PASS
```

Repeat from `apps/mobile`:

```sh
npx vitest run sources/components/buzz/ConversationComposer.desktop-voice-entry.browser.test.ts --maxWorkers=1 --minWorkers=1
```

The fixture bundles the real composer, VoiceBar and React Native web renderer.
Mouse events and the voice hook return value are scripted. No microphone
capture, server join, RTC audio, speech provider or spoken name-switch is
demonstrated by this entry proof. The required live Conversation audio proof
remains pending. The separately approved waveform control is deferred under
the latest commander correction.
This change builds no new entry control and changes no native condition.

PR #2436 already provides Web Speech dictation. Its existing real-Chrome
fixture passes prefixed/standard recognition, transcript insertion, stop/send,
denial/retry and discard, with scripted recognition events. Engines without
Web Speech, including Firefox and desktop WebViews without that API, have no
dictation mic in that merged implementation. Actual acoustic recognition is
not verified here.

The initial gate snapshot passed 69 tests in an isolated checkout. Revision 5
also includes the recorder fallback, transcription CORS headers and Tauri
microphone permissions below; those changes are now owned in this PR.

## Recorder fallback

Reproduction desktop-recorder-1: force Web Speech absent in Chrome and open
the real composer. On the pre-recorder detached checkout, the exact browser
capture script times out waiting for `chat-mic`; the visible composer contains
only Attach and the disabled Send arrow. No transcription is attempted.

After the fix, supported browsers still choose Web Speech. Tauri and browsers
without Web Speech choose the recorder. Running:

```sh
node --import tsx apps/mobile/scripts/prove-browser-recorder.mjs
```

uses a trusted CDP mouse gesture, actual Chrome fake-device `getUserMedia`,
Web Audio processing, the real adapter, hook, WAV compression/upload and
composer. Web Speech is disabled, not mocked into returning text. The HTTP
transcription response is stubbed to `Hello desktop.`; no speech provider or
acoustic recognition is claimed. The JSON records 7740 uploaded bytes,
16 kHz ADPCM WAV, `en`, the Jellybean/Ruby lexicon, text insertion and sending,
released mic tracks and revoked audio blobs. Results: `recorder-capture.json`;
captured composer: `recorder-capture.png`.

Reproduction desktop-speech-cors-1: a real HTTP OPTIONS request to the server's
transcription route requests `x-speech-language` and `x-speech-prompt`. Before
the change, the CORS regression fails because both are missing from the
allow-header list. With the change, preflight permits both. This does not
change allowed origins or authenticated POST policy.

Tauri declares macOS microphone usage and hardened-runtime audio-input
entitlement. The main Linux WebKit view authorizes UserMedia requests while
leaving other permission requests to existing handlers. Linux compilation
passes with the pinned dependency versions:

```sh
CARGO_BUILD_JOBS=2 RUSTC=/home/lunchbox/.rustup/toolchains/1.95.0-x86_64-unknown-linux-gnu/bin/rustc /home/lunchbox/.rustup/toolchains/1.95.0-x86_64-unknown-linux-gnu/bin/cargo check --locked --manifest-path apps/mobile/src-tauri/Cargo.toml
```

The system Cargo 1.75 cannot parse a locked dependency's Rust 2024 edition;
the installed 1.95 toolchain succeeds. A full Tauri binary build and launch
were **not run**. No macOS or Windows executable/permission dialog was tested.

Verification: 118 tests pass across eight mobile suites, including both Chrome
fixtures, adapter precedence, server-only finalization, recorder failure and
cleanup; all five recorder tests pass again after removing a test-only codec
export. Fifteen server CORS/transcription tests pass. Root typecheck,
corner:prepare, UI component policy and workflow-path lint pass. Conversation
RTC spoken-reply/name-switch/stop proof is independently assigned and remains
pending; these results must not be represented as its completion.
