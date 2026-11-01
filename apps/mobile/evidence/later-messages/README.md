# Later-message recovery on Android

Reproduction **LATER-1**: open an older Room message, load later messages,
then tap the error footer. An unavailable forward cursor keeps returning
`404/not_found`; repeating it cannot advance the transcript.

The owner's production cause is unconfirmed. A Sentry search for mobile history
issues returned no results. The closest stand-in uses the production
`useRoomMessageStore` in a native Android fixture with controlled history replies.
The real local server test in `phone-socket.integration.test.ts` separately
confirms repeated socket `readHistoryAfter` requests return `not_found`, the HTTP
history-after route returns 404, and latest history remains readable.

## Android result

Built debug Beeline APK, API 36 emulator, React Native 0.83.1 and Hermes.
Both runs used `scripts/later-messages-native-proof.tsx` and the same APK.
Only `room-message-store.ts` was switched between main and the fix.

1. Tap **Open older message 27**.
2. Tap **Load later messages**. The fixture returns 503 and shows the retry footer.
3. Tap the footer. The fixture returns 404 for the same cursor.

Before: repeated taps return 404 and keep the older window and error footer
([screenshot](baseline-retry.png)).

After: the retry returns to the session's live tail, shows Message 227 and removes
the footer ([screenshot](fixed-retry.png)). UIAutomator confirmed all three facts.
This proves native store/press/render recovery, not a production Room replay or
the full search/notification navigation stack.

## Repeat

Build shared packages and install mobile dependencies. Build a debug Android APK
with Expo prebuild and Gradle `:app:assembleDebug -PreactNativeArchitectures=x86_64
--max-workers=2`. Temporarily set mobile package `main` to
`scripts/later-messages-native-proof.tsx`, start Expo on port 18081, reverse that
port with adb, and open
`beeline://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A18081`.
Restore `main` to `index.ts` afterward. The fixture uses no account or production
service.

Regression coverage also includes an immediate missing cursor, retry after a
transient failure, a late error after a newer jump, and the existing successful
walk from an older window to the live tail. The new recovery assertion failed
on main before the fix.
