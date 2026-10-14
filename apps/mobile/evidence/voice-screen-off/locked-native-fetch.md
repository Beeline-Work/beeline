# Reproduction voice-screen-off-1: locked HTTP delivery

React Native's installed whatwg-fetch resolves its XHR onload through setTimeout. Android pauses that JavaScript timer while locked. The network response can arrive while the voice idle decision remains pending until unlock. Voice requests now use expo/fetch through the existing authenticated MonolithSession, including refresh and the one 401 retry. Other requests retain their existing dispatch behavior.

## Locked idle-end

Measured on private emulator-5558, 2026-10-14. Join response: 14:58:28.379Z. Native silence deadline issued idle at 14:58:50.587Z; HTTP 200 reached JavaScript at 14:58:50.724Z. Leave started at 14:58:50.744Z and returned 200 at 14:58:50.765Z. Server participant left_at: 14:58:51.711Z, call null. Before any unlock, dumpsys power showed mWakefulness=Asleep and dumpsys activity services app.usebeeline contained no VoiceAudioService. Raw records are /tmp/jellybean-voice-fix/idle-{logcat.txt,power.txt,services.txt,metrics.json} on squire. This establishes locked request completion and service teardown; audible chime verification is still part of acceptance.

## Validation

52 tests passed across auth session, native transport and the production voice hook. Native request/response completes with fake timers paused; auth refresh and 401 retry use the same native implementation, retain session fencing, and never call the fallback fetch. Root typecheck passed. These tests do not constitute a measured soak.
