# Waveform retune proof

## Reproduction WL2

Press the Android composer microphone, deliver `volumechange` values -2 (silence), 2 (quiet), 4 (normal), and 7 (loud), and advance the 120 ms waveform sampler between inputs. `ConversationComposer.speech.test.tsx` exercises this full microphone → speech listener → composer → rendered waveform path.

Running that regression against the pre-retune mapping fails: the quiet bar is exactly 2 px (flat), and normal input also remains at the floor because the old Android -2..30 envelope converts 4 to -48.75 display dB. This is an injected reproduction of the reported symptom, not a recording from the owner's phone.

The retuned composer regression passes and prints increasing smoothed heights. The unit table additionally checks silence, quiet, normal and loud bands on iOS, Android and voice, and verifies movement between normal syllables without saturation.

## Input units and cause

Checked the installed expo-speech-recognition 3.1.3 native source:

- iOS `ExpoSpeechRecognizer.swift` computes `20 * log10` of the PCM positive peak, clamps -60..0 dBFS and scales it to -2..10. The adapter reverses that scaling. This is peak metering, not RMS.
- Android `ExpoSpeechService.kt:onRmsChanged` forwards the recognizer's RMS dB unchanged. The package's [event contract](https://github.com/jamsch/expo-speech-recognition/blob/v3.1.3/src/ExpoSpeechRecognitionModule.types.ts) documents -2..10, with readings below 0 inaudible. The previous -2..30 display envelope was an assumption, not a native conversion. Android readings are recognizer-relative; the display conversion does not make them calibrated dBFS.
- LiveKit `Participant.ts` exposes 0..1 `audioLevel`; `Room.ts` assigns speaker levels from server updates. The existing linear-amplitude-to-dB adapter remains in use.

Both adapters still use `waveformLevelFromDb`. Its fixed display range is now -50..-15 with a linear display response, rather than -50..-5 raised to 1.5. This restores gain without per-take normalization. No bar count, colour, layout or animation timing changed.

## Rendered proof

`injected-volumes.png` shows the actual shared React Native Web component in local headless Chrome at 800 × 820 after 7.5 seconds of sampling. `browser-readings.json` records the newest rendered bars (browser pixel rounding included):

| Level | Dictation event | Voice amplitude | Display level | Rendered height, both paths |
| --- | ---: | ---: | ---: | ---: |
| Silence | -2 | 0 | 0% | 2 px |
| Quiet | 2 | 0.01 | 28.6% | 6.5625 px |
| Normal | 4 | 0.031622777 | 57.1% | 11.140625 px |
| Loud | 7 | 0.177827941 | 100% | 18 px |

Display percentages refer to the existing 16 px dynamic range above the 2 px minimum. Run `node apps/mobile/scripts/render-waveform-proof.mjs`, open http://127.0.0.1:4189 and allow the samples to enter the field.

## Device attempt and limits

This session started an isolated `dictation_api34` emulator through `beeline emulator -avd dictation_api34 -no-window -gpu swiftshader_indirect`. Its host reported `Could not init 'pa' audio driver`; adb remained offline during the capture attempts. No real recorded microphone values were obtained, and no iOS device was attached. Source-backed event-range inputs were used instead. The four speech categories are tuning points within the native range, not measured phone-distance calibration. Recognizer and microphone differences still require observation on a physical phone.

## Validation

- `npm run corner:prepare` passed.
- 90 focused tests pass across waveform mapping, speech input, voice source selection and the full composer microphone path.
- Root `npm run typecheck` passed.
- Browser component rendering confirmed the four heights above.
