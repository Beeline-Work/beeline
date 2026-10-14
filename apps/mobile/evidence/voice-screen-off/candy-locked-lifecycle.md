# Locked-screen Conversation-mode lifecycle proof (fallback2), and why fallback1 fails

Machine: squire. Emulator 37.1.11, AVD `buzzy_api36` (API 36), my lease `emulator-5562` (released). Read-only against the main worktree; no main-repo writes. `emulator-5554` and production services untouched.

## Result in one line

The 10-minute locked run proves the foreground service, microphone, RTC session and agent reply playback all stay alive with the screen off, but the **20-second idle park does not work**: the decision is a JavaScript `setTimeout` that is deferred while the app is locked, and when it finally runs the parked participant is immediately ended instead of holding for the reply.

## Fallback1 (host PulseAudio input): fails on this host

- Emulator log for a default/`pa`-backend launch prints `Could not init 'pa' audio driver`, also with `QEMU_AUDIO_DRV=pa PULSE_SERVER=unix:/run/user/1000/pulse/native`.
- The host has no `/dev/snd` at all, so `-audio alsa` cannot work; `-audio sdl` documents "no audio input supported".
- The only working input backend is `-audio wav` (previous artifact `fd98fe65`): a `qemu_in.wav` in the emulator CWD is opened read-only and looped into the guest mic. This is what fed the proof below. Real PCM was verified by cross-correlation (0.99) and by the fixture's STT.

## What I ran

Fixture services were already live (Jellybean's): proof server `127.0.0.1:18090`, LiveKit `127.0.0.1:26880`, Metro `8082`. I only read `/proof/metrics` and did not restart them. I installed `pocketsphinx` into `/tmp/voice-proof-python` so the fixture's `scripts/voice-screen-off-stt.py` recognized for real.

```bash
# 1. Emulator with the proven mic-injection backend, launched from the qemu_in.wav directory
cd /tmp/candy-voice/live                 # contains qemu_in.wav = "ruby work" + 25 s silence, 44100/16/2
export QEMU_AUDIO_DRV=wav QEMU_WAV_PATH=/tmp/candy-voice/live/qemu_out.wav
beeline emulator -avd buzzy_api36 -no-window -gpu swiftshader_indirect -audio wav -allow-host-audio

# 2. Install + load the isolated proof entry (the APK is a dev client; Metro serves the entry bundle)
adb install -r -t .../apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
python3 - <<'PY'   # tiny manifest server on :18091 whose launchAsset points at the native-entry bundle
# manifest copied from http://127.0.0.1:8082/ with launchAsset.url =
# http://10.0.2.2:8082/evidence/voice-screen-off/native-entry.bundle?platform=android&dev=true&...
PY
adb shell am start -a android.intent.action.VIEW \
  -d "beeline://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A18091%2F"
adb shell pm grant app.usebeeline android.permission.RECORD_AUDIO
adb shell input tap <START CONVERSATION>     # proof screen button
adb shell input keyevent 223                  # screen off
```

App config in use: `buzzyMonolithUrl = http://10.0.2.2:18090`, LiveKit join URL `ws://10.0.2.2:26880`. The fixture recognized `ruby work`, dispatched a command, and its deterministic worker committed a `done:` report 35 s later.

## Ten-minute locked run (PASS for alive-ness)

Window **2026-10-14T05:15:57Z → 05:26:34Z**, screen `mWakefulness=Asleep` the whole time; 21 samples every 30 s (log `observation-run2.log`):

- FGS: `app.usebeeline/.voicebackgroundaudio.VoiceAudioService`, `isForeground=true`, `types=0x00000080` (microphone) in **21/21** samples; ongoing silent notification `Conversation is listening · Stop`.
- Audio: `Recording active: true` in **21/21**; `Playback active: true`; communication route shows the app uid with both flags.
- RTC/voice: one server-side participant for the whole run; STT stayed open; **32** `EndOfTurn` recognitions of `ruby work`; server synthesized TTS grew `984156 → 4500704` samples in this run (5156808 total).
- App PSS **355888–361888 KB** (RSS ~460–466 MB), no growth trend; earlier run 350278–352545 KB.
- AudioFlinger showed an active client track for pid 5092 / uid 10216 (`app.usebeeline`), 8 kHz mono, `Active: yes`.

This is the "keep Conversation mode alive for hours with the screen off" half: the native FGS plus the RTC/audio path survives a locked 10-minute window.

## The 20-second idle park FAILS (server evidence)

Two measured cases:

1. **While locked, the timer does not fire at all.** Run 1: at `05:13:30Z` I replaced `qemu_in.wav` in place with silence (the driver read the new bytes; recognition stopped after `05:13:12Z`). For the next **89 seconds** the session stayed active: `closed=0`, `parked_at=None`, frames kept rising, notification stayed `Conversation is listening`. On `input keyevent 224` at **05:14:59Z** the overdue callback fired immediately and the call ended: `closed 0→1`, `left_at=2026-10-14T05:14:59.591Z`, `call=None`, notification `Tap to return to your Room and start again`. The JS timer was deferred until the app was foregrounded.

2. **When it does run (foreground), the parked state collapses to ended.** On `05:27:37Z` a command was pending (`worker claimed`). I silenced the mic. At **05:28:01.762Z** the server set `voice_participants.parked_at`, and `closed` went `1→2` (STT closed / RTC participant removed). **40 ms later**, at **05:28:01.802Z**, `left_at` was set and `call` became `None`; the notification became `Tap to return to your Room and start again`. The worker's report committed at `05:28:03.571Z`, after the session had already ended, so there was no reply playback into the parked session and no mic reopening.
   Final `participants`: `[{"parked_at":"2026-10-14T05:28:01.762Z","left_at":"2026-10-14T05:28:01.802Z"}]`.

Code locations that produce this (main worktree, PR2454 draft branch):
- Idle decision is client-side JS: `apps/mobile/sources/buzz/use-voice-call.ts` `armSilence()` sets `silenceTimer.current = setTimeout(expireSilence, 20_000)`; `expireSilence()` calls `POST /v1/phone/voice/:id/idle`, then `room.disconnect()` + `parkAudio()`.
- Server: `apps/server/src/voice-service.ts` `idle()` sets `parked_at` and returns `parked|ready|ended`; `idleState()` decides from pending unspoken `voice_orders`.
- Native: `apps/mobile/modules/voice-background-audio/.../VoiceAudioService.kt` `ACTION_IDLE_END` posts the "Conversation ended" notification and stops the FGS; `ACTION_ACTIVITY` is the "Waiting for …" park notification.

## Exact remaining limitation

The 20 s idle/park decision runs on the React Native JS thread. With the screen off the callback is deferred until the app is foregrounded, so while locked the microphone and RTC stay open (the FGS keeps them alive) and no park happens. When the callback does run, the parked participant is ended ~40 ms later (`left_at` set), so the design's "park, then reply speaks and reopens mic" path is not reached. A native idle timer/alarm (or moving the decision into the FGS) plus a server park state that persists until the reply is the missing piece.

## Recommendation

Do not claim the twenty-second contested-continuation behavior on emulator. The 10-minute locked FGS/mic/RTC/reply-playback evidence is real; the idle-park acceptance needs either a native timer in `VoiceAudioService` (so it fires while locked) and a fix so `parked_at` is not immediately followed by `left_at`, or an owner internal-device test. I can take either: wire the native idle timer and re-run this same fixture, or draft the exact owner device-test steps.

## Files kept

`/tmp/candy-voice/observation-run1.log`, `/tmp/candy-voice/observation-run2.log`, `/tmp/candy-voice/seq-rw.wav`, the captured guest mic WAVs, and `/tmp/candy-voice/reproduce.sh` (wav-backend mic injection).
