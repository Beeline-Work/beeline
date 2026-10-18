# iPhone call update instruction

Reproduction `iphone-022-gate`: on an unsupported iPhone binary, tap the call
control. Previously the gate returned “Conversation mode is not available in
this iPhone version yet. It arrives in the next App Store update.” The dialog
had only OK, and the call card repeated that instruction.

The owner confirmed the affected phone runs 0.2.21. Brief revision 2 replaces
real-iPhone call proof with copy and link tests; no real-device call connection
is claimed here. No native capability checks or Android behavior changed.

The fixed gate returns “Update Beeline in the App Store to join calls.”
`voice-update.test.tsx` passes this refusal through the real ModalManager and
WebAlertModal adapter, verifies its body and OK/Update actions, invokes Update,
and records the Linking URL. It verifies both the App Store scheme and an HTTPS
fallback when opening the scheme rejects. It also renders the real VoiceCallCard
and checks its error text. Native Linking and the final Hull dialog are test
substitutes; the test does not install an App Store update.

Repeat from `apps/mobile`:

```sh
npx vitest run sources/buzz/voice-update.test.tsx sources/buzz/voice-transport.ios-compat.test.ts sources/buzz/sentry.test.ts --maxWorkers=2
```

The iOS compatibility test verifies the gate still refuses before LiveKit loads,
and the Sentry tests verify this expected refusal is not captured.
