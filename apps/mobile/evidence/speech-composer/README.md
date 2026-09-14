# Speech-to-text composer — Android API 36

Captured from the real Beeline Android development build on `emulator-5554`
(API 36), running the branch bundle from Metro against a local monolith server
(`beeline://review/<secret>` reviewer sign-in, seeded default Workspace, Room
`#welcome`).

The mic glyph (A) sits left of the send arrow in `ConversationComposer`, per
the composer adjunct order: attach · input · mic · send.

| Capture | Shows |
| --- | --- |
| `composer-idle-mic.png` | Idle composer: `Start speech input` mic button between the input and send arrow. |
| `permission-prompt.png` | First mic press raises the platform `RECORD_AUDIO` runtime prompt (`expo-speech-recognition` permission flow). |
| `composer-listening.png` | Recognition session started (mic pressed after grant). |
| `composer-nothing-recognised.png` | Emulator recogniser returned no speech: the honest `nothing-recognised` state renders the status line `DIDN'T CATCH THAT · TAP MIC TO TRY AGAIN` under the composer. |

Notes:

- The emulator ships no spoken input, so the finals path (`partialText`
  overlay → committed transcript) is covered by `speech-input.test.ts`,
  `ConversationComposer.speech.test.tsx`, and `ConversationComposer.test.tsx`;
  the captures above prove the native integration end to end (glyph, permission
  prompt, recogniser lifecycle, and the `nothing-recognised` status line).
- The floating Tools control is supplied by the Expo development client and is
  not part of Beeline's application UI.
