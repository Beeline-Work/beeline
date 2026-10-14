# Voice background audio native module

The JS owner controls session policy. `start(roomDeepLink)` returns a native generation. Pass it to `setActivity(active, waitingFor, generation)`, `endForIdle(roomDeepLink, generation)` and `stop(generation)`. Commands for an ended or superseded session are ignored. Park keeps the Android microphone foreground service while releasing its audio wake lock. Mic capture and STT are closed by the client/server transport.

The transport sends a same-Room deep link with a unique voiceResume intent. Its response handler handles Android links and iOS local notification resumeUrl payloads, navigates to the Room and directly rejoins once. Stop events carry their generation so late events cannot terminate a successor.

Baby authored the initial Android/iOS module patch; integration repairs and lifecycle policy are maintained in the voice-screen-off corner. Platform/device proof is recorded separately under evidence/voice-screen-off.
