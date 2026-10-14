# Reproduction voice-screen-off-1: locked HTTP delivery

React Native's installed whatwg-fetch resolves its XHR onload through setTimeout. Android pauses that JavaScript timer while locked. The network response can arrive while the voice idle decision remains pending until unlock. Voice requests now use expo/fetch through the existing authenticated MonolithSession, including refresh and the one 401 retry. Other requests retain their existing dispatch behavior.

## Locked idle-end

Measured on private emulator-5558, 2026-10-14. Join response: 14:58:28.379Z. Native silence deadline issued idle at 14:58:50.587Z; HTTP 200 reached JavaScript at 14:58:50.724Z. Leave started at 14:58:50.744Z and returned 200 at 14:58:50.765Z. Server participant left_at: 14:58:51.711Z, call null. Before any unlock, dumpsys power showed mWakefulness=Asleep and dumpsys activity services app.usebeeline contained no VoiceAudioService. Raw records are /tmp/jellybean-voice-fix/idle-{logcat.txt,power.txt,services.txt,metrics.json} on squire. This establishes locked request completion and service teardown; audible chime verification is still part of acceptance.

## Validation

52 tests passed across auth session, native transport and the production voice hook. Native request/response completes with fake timers paused; auth refresh and 401 retry use the same native implementation, retain session fencing, and never call the fallback fetch. Root typecheck passed. These tests do not constitute a measured soak.

## Park/reply attempt and handoff limitation

A fresh private emulator-5562 was booted with 44.1kHz stereo ruby work plus silence. Installation eventually succeeded. Metro initially failed because Gradle removed a watched temporary CMake directory; restarting Metro with CI=1 eliminated that watcher. The fresh development client also required debug_http_host=10.0.2.2:8082 for lazy bundles. Its loaded buildCommitSha was fc54ffc6c3253f40a4cbcc6364a1ac0a3ed63c0f. Repeated system/Beeline ANR dialogs prevented starting a verified park/reply session. The concurrent rebuild was stopped; no replacement APK build success is claimed. Park/reply was not obtained in this attempt. The long acceptance runs are not ready to be declared passing.

Available development-client APK SHA-256: f48c31a09f1e06c15864fa1e438b948cef21037a35579fa004efa4400fe60289. It loads head JavaScript from Metro; it does not embed the fix. Full runner is acceptance-runner.md. Raw diagnostics remain under /tmp/jellybean-voice-fix on squire.
