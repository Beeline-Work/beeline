# Waveform level proof

Reproduction WL1 uses injected Android `volumechange` events. Press the composer microphone, then emit raw values -2, 12, 20 and 30, advancing the waveform sample timer after each. Before the fix, the three non-silent values all produce the maximum 18 px bar. After the fix they produce distinct increasing bars. `ConversationComposer.speech.test.tsx` exercises that complete composer path and prints its smoothed heights.

The fixed Android mapping produces unsmoothed heights 2, 5.472, 11.259 and 18 px respectively. The shared curve uses -50..-5 dBFS raised to 1.5, followed by light attack/release smoothing in the waveform. Voice amplitude is converted with `20 * log10(amplitude)`; iOS dictation reverses expo-speech-recognition's -60..0 dBFS to -2..10 scaling. Android's recognizer-relative RMS dB is mapped from an assumed -2..30 envelope to -60..0 dBFS. There is no adaptive normalization.

## Browser evidence

`injected-volumes.png` captures the **actual shared React Native Web waveform component**, built from this checkout, in local Chrome at 800 × 820. It shows fixed injected input levels for dictation and voice after seven seconds of sampling. `browser-readings.json` records actual rendered bar heights. Run `node apps/mobile/scripts/render-waveform-proof.mjs`, open http://127.0.0.1:4189 and allow seven seconds for the bars to enter the field.

This is an injected-level component proof, not a physical audio measurement or a production deployment. The signed-in production Room at web.usebeeline.app was inspected through Trusty Squire; it offers no dictation microphone, consistent with `speech-recognition-adapter.ts` returning null on web. That session was already signed in as the owner; a GitHub reviewer-bypass login was **not obtained**. Production varying-audio proof remains outstanding; this change does not add web dictation or deploy a release.

## Native coverage and calibration limits

Started the isolated `dictation_api34` Android emulator with `beeline emulator`. It booted successfully, but its host audio driver reported `Could not init 'pa' audio driver`, and no Beeline application was installed in the fresh emulator data. Physical silence/quiet/normal/loud microphone samples were not obtained. No iOS device was available.

The tested ranges are **injected values**, not measured device calibration: Android -2/12/20/30 RMS dB; iOS equivalent -60/-40/-20/-5 dBFS; LiveKit linear 0/0.01/0.1/0.56234. iOS scaling was checked against the installed expo-speech-recognition 3.1.3 implementation. Android passes recognizer RMS dB through unchanged; its -2..30 display envelope is an assumption and may understate quiet speech on a recognizer with a narrower range. Confirm it on the owner's physical Android microphone before treating it as calibrated.

## Accepted proof scope

The commander accepted the disclosed injected proof as sufficient for PR #2416 and waived physical-microphone calibration and production audio proof for this PR. The Android -2..30 dB envelope remains an assumption. The owner will check it on their phone after the build ships. All source envelopes, display range, perceptual exponent and smoothing weights are centralized in `sources/buzz/waveform-level.ts` for tuning.

## Validation

- 84 focused tests pass, including the composer microphone path, silence/finalization behavior, voice local/bridge source selection, fixed-value mapping and smoothing.
- Root `npm run typecheck` passes after installing the missing root dependencies.
- No layout changes.
