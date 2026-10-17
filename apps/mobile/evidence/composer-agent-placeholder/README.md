# Teach agent tagging

This is an approved UX addition, not a defect report. Previously every empty composer showed `Message`, and an untagged send gave no private feedback.

Rooms and corners with agents show `Tag an agent with @`. DMs and Rooms without agents retain `Message`. A successful untagged human send adds `No agent was tagged` under that message on the sending device. Tagging either a person or an agent clears the local hints. Leaving the conversation, changing Rooms or changing viewers also clears them. Nothing is persisted or sent to other devices.

## Android proof

The standalone `scripts/composer-agent-placeholder-native.tsx` fixture renders the production `ConversationComposer` and `OrdinaryLedgerMessage`, including the shared hint primitive and local-send hook. Two independently mounted hook instances represent the sender device and a second account device, displaying the same messages. Buttons simulate successful receipts; mention detection uses the existing composer mention resolver.

These are isolated fixture screenshots, not authenticated #general or two-account server screenshots. The task-owned emulator has no signed-in identity. The stand-in exercises the actual native message row and private hint lifecycle, but does not prove live account authentication, server roster delivery, or message fanout.

The [Bone untagged frame](hint/bone-untagged.png) and [Obsidian untagged frame](hint/obsidian-untagged.png) show the hint only in the sender's pane. The [tagged person](hint/bone-tagged-person.png), [tagged agent](hint/bone-tagged-agent.png), [DM](hint/bone-dm.png), [agent-free Room](hint/bone-no-agents.png), and [return after leaving](hint/bone-returned.png) frames have no hint. The [corner](hint/bone-corner.png) also shows the hint for an untagged send. Each state was asserted in both themes by Android UI Automator, including that any hint is above the second account's pane. Results: [hint-results.json](hint/hint-results.json).

The earlier revision's [Bone placeholder matrix](android-bone.png), [Obsidian placeholder matrix](android-obsidian.png), and [results](android-results.json) show the four placeholder choices together. The current interactive fixture replaces that static matrix.

## Reproduce

From `apps/mobile`, generate the ignored Android project with `npx expo prebuild --platform android --no-install`. Set its `react.entryFile` to `file("../../scripts/composer-agent-placeholder-native.tsx")` and disable Expo Updates in the generated manifest. Build with `android/gradlew -p android assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2`. Install the resulting APK only in a task-owned emulator launched with `beeline emulator`, and open `app.usebeeline/.MainActivity`.

Run `python3 scripts/composer-agent-placeholder-proof.py --device emulator-<leased-port> --out evidence/composer-agent-placeholder/hint` from `apps/mobile`. The fixture starts in Bone with no messages. No generated native configuration or APK is committed.

## Validation

Root `npm run typecheck` and `npm run lint:ui-components` pass. There are 224 passing tests across the composer, message variants, local hint hook, desktop inspector, composer design, calm lint and design lint suites. Coverage includes failed sends, second-account rendering, another device for the same sender, human and agent tags, and delayed receipts after leaving. Desktop integration tests exercise its real send handler with the current roster.
