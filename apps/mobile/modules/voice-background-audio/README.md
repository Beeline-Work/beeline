# Voice background audio native module

The JS owner controls session policy. `start(roomDeepLink)` returns a native generation. Pass it to `setActivity(active, waitingFor, generation)`, `endForIdle(roomDeepLink, generation)` and `stop(generation)`. Commands for an ended or superseded session are ignored. Park keeps the Android microphone foreground service while releasing its audio wake lock. Mic capture and STT are closed by the client/server transport; the muted published track and both RTC connections remain negotiated. Reply resumption restores audio and server STT without a new join.

The 20-second silence deadline is native but decided by JS: `armSilence(generation)` on listening, `cancelSilence(generation)` when the person resumes or the agent speaks. A one-shot `idleRequested { generation }` event fires once per armed deadline; it never ends the session itself. The JS policy then runs the existing idle/park path. Android runs the deadline on the service's main looper (not React Native's TimingModule); iOS uses a main-queue `DispatchWorkItem`. Every deadline is generation-fenced and is cancelled on reset, stop, idle end, activity change and service destroy.

The transport sends a same-Room deep link with a unique voiceResume intent. Its response handler handles Android links and iOS local notification resumeUrl payloads, navigates to the Room and directly rejoins once. Stop events carry their generation so late events cannot terminate a successor.

Baby authored the initial Android/iOS module patch; integration repairs and lifecycle policy are maintained in the voice-screen-off corner. Platform/device proof is recorded separately under evidence/voice-screen-off.

`configureStop(url, token, generation)` stores a server-issued Stop-only capability in native memory. Android notification Stop sends a bounded native HTTP request before removing its foreground service; iOS remote Stop sends through URLSession. The capability expires after 24 hours and grants only leave for its exact participant session. It cannot stop a newer session, and is never persisted or passed in Android intents.
