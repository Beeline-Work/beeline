# Aura-only cleanup proof

2026-10-14, isolated corner on squire. This is feature cleanup, not a defect report.

## Demonstration AURA-ONLY-1

An owner opens the production Workspace Settings component. Name, Visibility,
Members and Delete Workspace render; there is no voice-provider row or picker.
The same source serves Android and desktop/web. `android-settings.png` and
`android-settings.xml` capture an isolated Android 35 emulator (emulator-5558),
using the debug native host and Metro with synthetic owner Workspace data.
No production Workspace was edited. The temporary entry and transport shims
were restored before validation.

The authenticated HTTP regression opens a disposable server, accepts an old
client Workspace update with a retired provider field, saves Apollo, and returns
a bounded 24 kHz WAV preview. Its PCM is synthetic. Migration coverage recreates
the old column and CHECK, runs the voice schema twice, proves both are gone,
removes retired selections, and preserves the saved Aura choice.

## Verification limits

The live fixture joined two authenticated humans to a disposable LiveKit call.
A live OpenRouter reply was obtained through the vault, but Aura PCM could not
reach the fixture: both Squire HTTP and streaming egress routes returned 502
`unsupported_response_type`. The local daemon environment had no resolvable
voice-provider secrets. No live voice reply or unchanged-latency claim is made.
Temporary egress grants were revoked and the fixture was cleaned up.

The requested reviewer-bypass check on web.usebeeline.app remains a post-deploy
check. This branch has not been deployed. iOS was excluded as requested.
