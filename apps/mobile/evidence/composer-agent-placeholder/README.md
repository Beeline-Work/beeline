# Composer agent placeholder

This is a requested UX hint, not a defect report. Previously every empty composer showed `Message`.

The shared composer now shows `Tag an agent with @` when its server member roster contains an agent and the conversation is not a DM. Rooms without agents, DMs, and the viewer dock retain `Message`. The main chat surface supplies both conversation kind and membership; the desktop corner inspector supplies its own server roster.

## Android proof

The standalone `scripts/composer-agent-placeholder-native.tsx` fixture renders the production `ConversationComposer` with real native Android TextInputs and bundled fonts for four cases: Room with agents, agent DM, Room without agents, and corner with agents. It makes no network requests. These are fixture screenshots, not authenticated Room screenshots: the isolated emulator has no signed-in identity. This is the closest native stand-in for the requested live #general/DM/empty-Room proof and does not prove live roster delivery.

To reproduce, generate the ignored Android project with `npx expo prebuild --platform android --no-install`, set its `react.entryFile` to `file("../../scripts/composer-agent-placeholder-native.tsx")`, and disable Expo Updates in the generated manifest. Build with `android/gradlew -p android assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2`. Install the resulting APK only in a task-owned emulator launched with `beeline emulator`. Open the app and use Toggle theme for the second frame. No generated native configuration or APK is committed.

Screenshots: [Bone](android-bone.png), [Obsidian](android-obsidian.png). Android UI Automator reported the expected four placeholders in both themes; values are recorded in [android-results.json](android-results.json). The fixture APK built successfully for x86_64 and ran on Android API 36.

## Regression coverage

`ConversationComposer.test.tsx` asserts rendered native input placeholder props for a Room and corner with agents, a Room without agents, an agent DM, and a human DM. The DM case explicitly has an agent member, ensuring agent membership alone does not switch the hint.

Validation passed: root `npm run typecheck`, `npm run lint:ui-components`, 37 composer/design tests and 18 desktop inspector tests.
