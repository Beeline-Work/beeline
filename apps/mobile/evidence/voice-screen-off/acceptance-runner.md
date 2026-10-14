# Squire acceptance runner

Use this corner checkout and its debug APK at `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`. This is a development-client APK: the fixed JavaScript comes from this checkout's Metro, not an embedded release bundle. Do not run it against production accounts. Runtime Android 37 / iOS 35. Fixture uses actual hook, native module, LiveKit PCM, server routes/socket, offline STT/TTS and a disposable database.

Read the fixture before running it. On squire the isolated LiveKit container `jellybean-voice-proof-livekit` already serves 26882, RTC TCP 26883 / UDP 26900–26920 with the development-only devkey/secret configuration in `/tmp/jellybean-voice-proof/livekit.yaml`. The fixture server already runs on 18090. For a fresh start, run from repository root:

```sh
PYTHONPATH=/tmp/voice-proof-python npx tsx apps/mobile/evidence/voice-screen-off/server.mts
```

In another terminal, from apps/mobile:

```sh
CI=1 EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:18090 npx expo start --dev-client --port 8082 --clear
```

CI mode prevents Gradle temporary-directory removal from crashing Metro's file watcher. Restart Metro after any checkout/source change. The already-running manifest proxy at 18091 is `/tmp/jellybean-voice-proof/manifest-proxy.py`; read it before starting a replacement. It forwards Expo manifest headers to 8082 and rewrites the entry to `evidence/voice-screen-off/native-entry.tsx`.

## Emulator and speech

Use a private emulator launched by Beeline. In an isolated scratch directory, prepare `qemu_in.wav` (44.1kHz stereo signed 16-bit) before boot. QEMU WAV input begins when recording starts. `ruby work` followed by at least 60 seconds of silence triggers the delayed worker report. `hello ruby` repeated with less than 20 seconds between phrases supports the 10-minute/60-minute acceptance runs. Use espeak-ng and ffmpeg to render these phrases; the fixture's pocketsphinx grammar accepts hello ruby, ruby work and stop conversation. Do not infer speech from a running input process: verify recognized transcript markers.

```sh
QEMU_AUDIO_DRV=wav QEMU_WAV_PATH="$PWD/qemu_out.wav" beeline emulator -avd buzzy_api36 -no-window -gpu swiftshader_indirect -audio wav -allow-host-audio
adb devices
```

Select the allocated emulator explicitly with `adb -s emulator-PORT` in every command. Wait until `getprop sys.boot_completed` prints 1 before installing. Grant RECORD_AUDIO and POST_NOTIFICATIONS. Set `settings put system screen_off_timeout 2147483647`. For a fresh development client, set its default SharedPreferences string `debug_http_host` to `10.0.2.2:8082`; otherwise lazy bundles try 8081. The XML used by this run is `/tmp/jellybean-voice-fix/dev-prefs.xml`, installed by piping it into `run-as app.usebeeline sh -c 'cat > shared_prefs/app.usebeeline_preferences.xml'` while the app is stopped.

Open the fixture:

```sh
adb -s emulator-PORT shell am start -a android.intent.action.VIEW -d 'beeline://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A18091%2F'
```

Dismiss the development-client introduction if shown. Tap Start Conversation, wait for an active call and STT opened in metrics, then `shell input keyevent 223` to lock. Use `curl http://127.0.0.1:18090/proof/metrics`, logcat filtered for VOICE-PROOF, dumpsys power, activity services app.usebeeline, notification --noredact and meminfo app.usebeeline. Preserve timestamps and raw files. Capture qemu_out.wav for audible replies/chime; count increases alone do not establish audible playback.

## Acceptance

Idle: silence with no pending command; after 20 seconds the call ends, foreground service disappears and restart notification appears, all before unlock. Listen for the soft chime. Tap the notification and verify one-tap restart into the same Room.

Park/reply: inject ruby work; wait for worker claimed, then stop input. After the 20-second deadline, prove parked_at set, STT closed, frame count unchanged and Waiting for Ruby… · Stop notification. At +35 seconds the report commits; before unlock verify TTS playback, parked_at cleared, STT reopened and frames increasing. Stop paths must remove the service and release audio.

Long acceptance: separately measure 10 minutes locked and 60 minutes with periodic recognized input and audible replies. Record call identity, participant state, PSS, open/closed STT counts and transcript; unlock and compare. No polling is added to product code; observations belong only to the runner. No billed providers or BrowserStack spending.

## Retained-RTC fix delivery

For the retained-RTC/native-Stop head, use the new APK, not f48c31a0. SHA-256 is `68006e819b8c5121abbdad573d1c1ffcdb4245403a5e2263544d6f85656757fc`. Concatenate the three attached `conversation-native-apk.zip.part1`–`part3` files in numerical order, unzip, and verify `sha256sum app-debug.apk`. The ZIP is split solely to fit the Room's 25 MB artifact limit.

The scratch Gradle build used a writable copy of mobile sources/dependencies and `--no-daemon --max-workers=2 -PreactNativeArchitectures=x86_64 -Dorg.gradle.jvmargs=-Xmx4g`; existing checked-in native caches were read-only. Runtime remains Android37/iOS35, both new relative to main36/34. It is a development client, so restart Metro and the fixture from the new pushed head before acceptance. The SDK/STT setup can be recreated with `python3 -m pip install --target /tmp/voice-proof-python pocketsphinx`.

Wait for an active Room and STT opened before locking. A lock during microphone foreground-service startup is an invalid run and Android14+ rejects it. For native Stop independence, the isolated proof screen offers **Block JS for native Stop proof** (30 seconds); only use it after the call is active. Tap the actual notification Stop action and inspect server left_at/call before the JS released marker. Coordinates vary; do not reuse a stale shade coordinate. The latest coordinate-based device Stop attempt did not obtain a native-stop request, so this assertion still needs acceptance. Step1 must pass before steps2–4.
