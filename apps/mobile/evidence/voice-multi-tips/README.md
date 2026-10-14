# Multi-human Conversation routing and speaking tips

Reproduction VOICE-MULTI-2. Two humans share one Conversation call. Speech that does not open with an agent's name gets no reply. A tap counts only while one human is in the call. "Gussie" and "Goosey" are not matched to Goosy. Unrelated speech from a second human may cut the agent off, or that human can never cut it off.

## Server over LiveKit RTC

The script uses an isolated PGlite database, the real join endpoint, real LiveKit RTC (local `livekit-server` v1.9.12) and the real voice runtime. Speech-to-text, the voice model and speech synthesis are local doubles, so no provider key is needed.

```sh
LIVEKIT_URL=ws://127.0.0.1:35880 LIVEKIT_API_SECRET=<dev secret> npx tsx scripts/prove-voice-multi-routing.ts
```

- `rtc-before-8c30b0d-parent.txt` is main before PR #2456.
- `rtc-before-8c30b0d.txt` is PR #2456 before this change.
- `rtc-before-35b1965.txt` is the head before the tapped-backchannel fix.
- `rtc-before-e4f9d76.txt` is the head before the name-only fix.
- `rtc-after.txt` is this change.

## Conversation panel

Chrome, from apps/mobile:

```sh
npx vitest run sources/components/buzz/VoiceBar.tips.browser.test.ts
```

This writes the `chrome-*.png` screenshots.

Android uses AVD `buzzy_api36` (API 36, x86_64, 1080x2400). Build a release APK with `react.entryFile` set to `../../scripts/voice-multi-tips-native-proof.tsx` and OTA disabled. Install it, then:

```sh
python3 apps/mobile/scripts/voice-multi-tips-android-proof.py --device emulator-5558 --out apps/mobile/evidence/voice-multi-tips
```

This writes the `android-*.png` screenshots and `android-ui.txt`.
