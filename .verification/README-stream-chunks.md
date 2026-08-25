# Streaming transcript verification

Captured from the Android API 36 emulator with the production transcript components in a release APK.

- `stream-chunks-live.png`: one live turn showing rolling thought, individual tool verdicts, and the accumulating message lane.
- `stream-chunks-success.png`: the settled successful turn; only the durable agent message remains.
- `stream-chunks-failure.png`: the settled failed turn; one brass failure fact remains beside the durable agent message.

The capture-only query fixture and disabled-update manifest override were removed before validation and are not part of the shipped source.
