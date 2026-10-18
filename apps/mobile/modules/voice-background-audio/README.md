# Voice background audio native module

`start(roomDeepLink)` returns a native generation; `stop(generation)` releases its audio lifetime. Stop events carry that generation, so late events cannot terminate a successor. There is no native silence deadline or parked audio state. The runtime server ends the whole call after 60 seconds without human speech, agent playback or pending call-initiated work.

`configureStop(url, token, generation)` stores a server-issued leave-only capability in native memory. Android notification Leave sends a bounded native HTTP request before removing its foreground service; iOS remote Stop sends through URLSession. The capability expires after 24 hours and grants only leave for its exact participant session. It cannot stop a newer session, and is never persisted or passed in Android intents.

The Android foreground microphone service remains disabled by policy. Session generation fencing remains active in the module. Existing notification links can still navigate to the Room; a new call requires an explicit user action after the previous call ends.
