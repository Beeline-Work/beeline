# Conversation composer proof

Local headless Chrome at 390px, in Obsidian and Bone. The proof renders the production ConversationComposer, VoiceBar, AttachmentPickerSheet and chat attachment uploader. Device recognition, file selection/reading and the upload endpoint are fixture boundaries; no live voice provider or production account is used.

Run from apps/mobile:

```
npx vitest run sources/components/buzz/ConversationComposer.conversation.browser.test.ts --maxWorkers=1
```

The proof checks connected silence, connection pending, listening and agent speech; the label is right-aligned on the avatar row and all controls remain available. It opens the existing attachment picker during agent speech, stages a document, ends the call, and sends the pending document with the next composer message, reusing the staged upload. It prints RESULT PASS in both themes. Screenshots show the final agent-speaking state.

This is feature work, not a defect report. Dictation and waveform level mapping are unchanged.
