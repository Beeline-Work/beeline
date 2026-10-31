# R1: Android dictation loudness

Reproduction R1: Room composer → mic → normal speech → spoken bars pin at full height.

The owner's Samsung is not attached to this host. The closest measured stand-in is
an Android 14 emulator (`dictation_api34`) running Google's recognition service and
feeding real `onRmsChanged` callbacks into the existing mapping. The native visual
proof runs the production `ConversationComposer`, `useSpeechInput`, and
`DictationWaveform` in a standalone screen with a WAV supplied to the recognizer.
It needs no Room sign-in. This is a file-fed recognizer proof, not a Samsung
microphone or full signed-in Room proof.

## Measurement

- Google service: `com.google.android.tts/com.google.android.apps.speech.tts.googletts.service.GoogleTTSRecognitionService`.
- Installed version: `googletts.google-speech-apk_20230123.02_p3.506463867`.
- The emulator's older `com.google.android.googlequicksearchbox` recognition component
  is disabled; binding returned error 10. Enabling it was rejected by Android.
  The active default service above is also Google's, but differs from the owner's
  Google app recognizer. Production service selection is unchanged.
- First tried host-microphone input (`adb emu avd hostmicon`) with speech played into
  PulseAudio's `beeline_mic1_in`. It yielded only `-2` and no-speech errors, so it
  did not provide usable voice measurements. The working route uses Android's
  `RecognizerIntent.EXTRA_AUDIO_SOURCE` pipe, signed little-endian PCM, mono,
  16 kHz, 320 bytes every 10 ms. See [probe](probe/app/src/main/java/proof/RmsActivity.java).
- Offline mode returned error 13 (no language model). Initial online attempts
  returned network error 2; the completed captures used the online recognizer
  and produced results. Only the completed captures are checked in.
- Input: the same synthesized English clip at three gains, generated with
  `espeak-ng`, then resampled and scaled to the RMS levels below. No personal
  speech was recorded. The labels describe controlled input gain, not measured
  sound pressure or a universal microphone calibration. The loud clip has a
  small amount of PCM peak clipping (RMS actually -18.002 dBFS).
- [callbacks.csv](callbacks.csv) preserves every raw callback, with milliseconds
  relative to the first callback in each take. [readings.json](readings.json)
  samples the latest callback every 120 ms, matching the scrolling bar cadence;
  the final callback is recorded separately to verify silence. Positive samples
  form the speech summary below. Callback-only medians are misleading because
  the recognizer omits repeated identical values (especially its capped peaks).

| Input | RMS dBFS | Raw callback range | Callbacks | Speech samples | Median raw | Old median height | New median height |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| Soft | -42 | -2 to 10 | 324 | 60 | 7.48 | 100% | 62.3% |
| Normal | -30 | -2 to 10 | 296 | 66 | 8.68 | 100% | 72.3% |
| Loud | -18 | -2 to 10 | 245 | 65 | 8.92 | 100% | 74.3% |

All ranges overlap because each phrase contains pauses and strong syllables.
The samples include silence, which maps to zero. Previously 44 of the 66 positive
normal-speech samples saturated. Now none do; the recorded peak of 10 maps to
83.3%. Soft < normal < loud for both mean and median speech height.

Android now maps positive recognizer-relative values directly to display height,
with a display ceiling of 12. This is deliberate display headroom above the
observed native ceiling of 10, not a claim that Android reports a maximum of 12.
Google already caps some normal syllables at 10, so giving 10 full display height
would leave avoidable flat peaks. Negative/zero readings are silence. This gain
is fixed: it does not normalize each take or flatten syllable differences.
iOS and LiveKit retain their existing dBFS mapping.

Limit: a native value already capped by Google cannot recover the lost acoustic
contrast. Device/recognizer gains vary, and this is not a calibration of the
owner's Samsung. The chosen gain fixes the demonstrated early display clipping
without introducing adaptation or changing transcription.

## Reproduced and demonstrated

The measured regression in `sources/buzz/waveform-level.test.ts` fails against the
original mapping: normal peaks equal 1, and all three speech medians equal 1.
The same fixtures pass after the change, including silence and invalid readings.

Native visual proof: existing Beeline debug APK (version 0.2.22, runtime 43), this
branch's JS served by Metro, Bone theme, emulator `emulator-5554`. Tap the real
composer mic. `native-proof.tsx` supplies the normal WAV through the existing Expo
speech module and chooses the installed Google service; all mapping, speech-hook
state, composer controls and bar rendering remain production code. Recording
upload is disabled in this isolated proof so no server account is needed.

- [Before: normal speech](before-normal.png): repeated full-height groups.
- [After: normal speech](after-normal.png): shorter groups with syllable contrast.

The normal phrase is identical before and after. The final after take appends
three seconds of digital silence. This cached Expo binary did not forward a final
silence volume callback from its WAV streamer; silence is instead checked with
the final raw `-2` readings captured by the Java probe and the regression test.
The standalone entry and adapter overrides are not used by the shipped entry.

## Repeat

Generate the source clip:

```sh
espeak-ng -w /tmp/speech.wav 'This is a normal speaking voice. The wave should rise and fall with every word. Softer words should draw shorter bars and louder words should draw taller bars.'
ffmpeg -i /tmp/speech.wav -ar 16000 -ac 1 -f s16le /tmp/speech.pcm
```

Scale PCM RMS to each target using `gain = 32768 * 10**(targetDbfs/20) / inputRms`,
round and clamp to signed 16-bit. Build the included minimal Android probe with
Gradle 9 and Android SDK 35 (`gradle -p probe :app:assembleDebug`). Install its debug
APK; grant `proof.rms` microphone permission. Push each scaled PCM file to
`/data/local/tmp/speech.pcm`, clear logcat, start `proof.rms/proof.RmsActivity`, and
capture `adb logcat -s R1RMS:I`. Stop the probe between takes. No production daemon,
account, or server is involved.

For the native composer proof, wrap the scaled normal PCM in a WAV container
(the Expo file streamer uses MediaExtractor, so bare PCM cannot be used there),
push to `/data/local/tmp/speech.wav`, and temporarily replace `apps/mobile/index.ts`
with an import of `./evidence/android-dictation-rms/native-proof`. Serve Metro to a
compatible debug client, tap the mic, and capture the screen. Restore `index.ts`
afterward. For the baseline screenshot use the original `waveform-level.ts`;
for the passing screenshot use this branch's version.

Validation:

```sh
cd apps/mobile
npx vitest run sources/buzz/waveform-level.test.ts sources/buzz/speech-input.test.ts --maxWorkers=1
```

Root `npm run typecheck` also passes.
