# Conversation composer proof

Local headless Chrome at 390px, in Obsidian and Bone. The proof renders the production ConversationComposer, VoiceBar, AttachmentPickerSheet and chat attachment uploader. Device recognition, file selection/reading and the upload endpoint are fixture boundaries; no live voice provider or production account is used.

Run from apps/mobile:

```
npx vitest run sources/components/buzz/ConversationComposer.conversation.browser.test.ts --maxWorkers=1
```

The proof checks connected silence, connection pending, listening and agent speech;
all controls remain available. It taps Jellybean, verifies the visible underline
and persistent selected state across those phases, and checks that 40 fixed
waveform blocks retain their positions while their heights follow the current
level. It then ends the call and sends a staged document with the next message,
reusing the upload. Both themes print RESULT PASS. Screenshots show Ruby speaking
while Jellybean remains selected.

Reproductions CONVERSATION-2 (tap selection) and CONVERSATION-3 (live waveform)
are also covered by the native component and speech-event tests. The browser
transport is controlled; it does not measure native microphone delivery.
