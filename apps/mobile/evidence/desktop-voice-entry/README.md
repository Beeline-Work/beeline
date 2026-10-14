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
demonstrated by this entry proof. The required live Chrome audio proof remains
pending, as does the separately requested Conversation button's locked design.
This change builds no new entry control and changes no native condition.

PR #2436 already provides Web Speech dictation. Its existing real-Chrome
fixture passes prefixed/standard recognition, transcript insertion, stop/send,
denial/retry and discard, with scripted recognition events. Engines without
Web Speech, including Firefox and desktop WebViews without that API, have no
dictation mic in that merged implementation. Actual acoustic recognition is
not verified here.

Verification: 69 tests pass across six focused suites, including both browser
fixtures, composer speech/trailing controls, voice hook and native transport.
The final focused run used an isolated detached checkout containing only this
PR's changes, because recorder/provider changes were being written separately
in the active worktree. Those changes are preserved outside this PR. Root
typecheck and corner:prepare pass in the active checkout; its typecheck includes
the separate unfinished recorder work.
