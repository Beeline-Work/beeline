# Speaking speed

New feature, not a defect report. Reproduction is not feasible; the named
stand-in is **SPEAKING-SPEED-1**.

Settings → Speaking speed offers Normal (default, 1.15×), Medium (1.3×), and
Fast (1.5×), using the same SettingsRow and action sheet as Text size. The
identity owns the preference, across Workspaces and devices. A call publishes
one shared audio track: each reply uses the speed of the human who triggered
it, including announcements and subsequent agent reports.

The input-start preference read joins the existing agents/budget Promise.all.
Committed identity changes invalidate that cache through the existing
PostgreSQL live bridge. A refresh clears the old value immediately, fences
late results against newer refreshes and input generations, and defaults to
Normal on failure. A reply snapshots the cached setting; its phrases cannot
change speed midway through the reply. No preference read occurs per reply.

## Demonstrated

- `voice-room-runtime.test.ts`, SPEAKING-SPEED-1: start a microphone input,
  synthesize a known one-second 220 Hz PCM tone through utterance → play →
  AudioSource.captureFrame at each speed. Published sample totals equal
  round(24000 / speed). Two replies require only one preference read. Refresh
  during the call changes the next reply; a failed refresh returns to Normal.
- `identity-live.e2e.test.ts`, SPEAKING-SPEED-1: actual PhoneService writes and
  reads over Pglite, through PostgreSQL notification bridge and phone WebSocket,
  notify the owner's second session only. Other identities retain Normal;
  unsupported speeds are refused.
- `voice-tempo.test.ts`: duration and pitch at all speeds across odd byte
  boundaries, immediate opening frame, unchanged quiet padding, invalid-value
  fallback. `phantomHarness` runs echo, interruption and caller-resume cases
  with Fast loaded through the input-start read.
- VOICE-SPEED-ONSET: fake-clock provider frames with one or five quiet opening
  frames, padding from -150 to 150, all three speeds. First voiced publication
  matches the original fixed-speed baseline (before/after 40/40 ms with one
  quiet frame; 120/120 ms with five; added delay 0 ms). This measures the
  controlled server publication path, not production network/provider latency.

## Visual evidence

The screenshots render the production AppearanceSetting, UiSizeSetting,
SpeakingSpeedSetting, SettingsRow and HullActionSheet components in an isolated
harness. Android uses Expo Go with native SVG matched to its runtime; Unistyles
and unused navigation/animation dependencies use the existing surface-proof
adapters. Desktop uses react-native-web and the existing browserProof adapters.
The harness replaces account/network context, so these are component surface
proofs rather than a signed-in production-account walkthrough. Backend sync and
playback are exercised separately by the exact paths above. No iOS verification.

- [Android dark](android-dark.png) and [picker](android-dark-picker.png)
- [Android light](android-light.png) and [picker](android-light-picker.png)
- [Desktop picker](desktop.png)
