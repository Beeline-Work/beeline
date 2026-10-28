# Connector message byline

This is an approved display simplification, not a defect report.

Proof CONNECTOR-BYLINE-1 uses `scripts/connector-byline-native-proof.tsx` to render real `OrdinaryLedgerMessage` rows with retained `sourceClient` data, the Meta Muse model label, both the default and a custom speaker name, and a continued human connector run. The corner's fresh Android emulator has no production account session; this local fixture is the stand-in for live #beeline history. It performs no production reads or writes.

The native fixture runs in a locally built x86_64 Beeline debug APK. Before captures use the base revision's Ledger and message variant; after captures use the branch implementation with the same input messages. The normal application entry is restored after capture.

Repeat by running `npm run corner:prepare`, `npx expo prebuild --platform android --no-install` in mobile, and `./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=2 -Dorg.gradle.parallel=false` in mobile/android. Temporarily import only `./scripts/connector-byline-native-proof` from mobile/index.ts, serve Metro with `npx expo start --dev-client --port 18887 --localhost`, install the debug APK on the corner's leased emulator, reverse port 18887, and open `beeline://expo-development-client/?url=http%3A%2F%2Flocalhost%3A18887`. Restore index.ts after capturing.

The browser before image records the previous connector header (`via Grok`); the updated browser message proof checks a custom name with one Meta Muse model label and no `via` text. The renderer regression additionally verifies that retained connector metadata is not passed to the byline and does not force a continued human header. Server metadata and attribution speaker keys are unchanged.

## Captures

- [Before on Android](android-before.png): `Meta Muse · via Meta Muse · Meta Muse`; both human rows carry a header.
- [After in Obsidian](android-after-obsidian.png): `Meta Muse · Meta Muse`, and `Muse · Meta Muse`; the human continuation has no repeated header.
- [After in Bone](android-after-bone.png): the same result in the light theme.

UIAutomator confirms four `chat-byline-client` nodes before and none after, two Meta Muse `chat-byline-role` nodes in both captures, and only one Alex header after. The floating gear is Expo development-client chrome.
