# Android locked-screen call with the microphone service re-enabled

Not a defect report. This records the device proof for undoing #2480.

## Setup

- Debug APK built from this branch (runtime android 40), SHA-256
  `af534f09afbbf542beecb226271accc2eb62f720d96ea9fa0c9ac32996d3efd5`.
  The merged manifest declares `VoiceAudioService` with
  `foregroundServiceType=0x80` (microphone) and both FOREGROUND_SERVICE permissions.
- Leased emulator `buzzy_api36` (API 36) on squire, PIN lock 1234.
- The isolated fixture from `../voice-screen-off/` (real hook, native module,
  LiveKit, server routes; offline STT/TTS; disposable database). The STT grammar
  copy used for this run adds the phrase `ruby how are you`, because the
  name-only `hello ruby` never counts as call activity, so the server's 60 s idle
  rule ended those calls.
- Mic input: QEMU WAV backend playing "ruby, how are you" every 15 s.

## Result: locked call (run 3)

Locked at 18:29:49Z with `input keyevent 223`. Raw samples: `locked-samples-run3.txt`.

- Every sample while locked: `isKeyguardShowing=true`, `mWakefulness=Asleep`,
  `VoiceAudioService isForeground=true types=0x00000080`, process capability
  `--MNFUAT` (M = microphone).
- STT recognized the phrase 8 times while locked (18:30:03Z to 18:31:48Z),
  and the agent answered each turn (TTS samples rose from 508781 to 1090245).
- The call stayed connected for 3 min 3 s locked, until 18:32:52Z.

The call ended because emulator mic input stopped, not because of the app. At
18:31:47Z the emulator audio HAL logged `pcm_readi failed ... I/O error` and
inserted silence. The server then ended the call by its 60 s idle rule. An
unlocked control call on another boot showed the same HAL errors (598 errors, no
recognition), so the failure is in the emulator audio path. The app kept its
microphone capability throughout. Confirm long locked calls on a real device.

## Result: lock-screen notification and Leave (run 5)

- Join at 18:41:20Z; service foreground, type microphone.
- Locked 18:41:45Z to 18:42:05Z: one more turn recognized at 18:41:55Z and
  answered while locked.
- After wake, the keyguard shows the ongoing "Call is listening · Leave"
  notification (`lock-screen-notification.png`, `lock-screen-leave-action.png`).
- Tapping Leave from the locked shade sent `native-stop` and `leave` to the
  server, removed the service and the mic indicator, and the keyguard stayed up.

The 48 s demo video for the Play declaration is posted as a corner artifact, not
committed.
