# Quiet row actions

This is the implementation of the approved button-sizing mock, not a defect report.

The Android release fixture mounts production ConversationComposer (A1), OrdinaryLedgerMessage with failed delivery (A2), RepositoryChoice (B3), MemberGrantRow (B4), and AgentSignInCard (B5). It supplies local failure/card facts and records callback outcomes; it sends no production commands. Screenshots were compared with the approved mock's after images in Bone and Obsidian. Retry stays on the upload info line; the delivery error has Retry and Dismiss; repository rows share the label edge; grant details share the title edge; the 26-point sign-in mark and right-aligned Open/Copy code match the card layout.

| State | Bone | Obsidian |
| --- | --- | --- |
| A1 / A2 | [Android](android-bone-a1-a2.png) | [Android](android-obsidian-a1-a2.png) |
| B3 | [Android](android-bone-b3.png) | [Android](android-obsidian-b3.png) |
| B4 | [Android](android-bone-b4.png) | [Android](android-obsidian-b4.png) |
| B5 | [Android](android-bone-b5.png) | [Android](android-obsidian-b5.png) |
| A5 / A6 | [Desktop web](web-desktop-bone.png) | [Desktop web](web-desktop-obsidian.png) |

[Android action receipts](android-results.json) cover upload Retry, delivery Retry and Dismiss, Link it instead, Revoke, and Copy code in both themes. Adjacent XML files retain native accessibility targets. Open's existing URL callback remains covered by AgentSignInCard tests.

Desktop screenshots render the production ErrorBanner and Button at sidebar/inspector widths inside a desktop viewport, with deterministic failure facts. These are component fixtures, not a live signed-in sidebar/inspector: inducing those network failures in a live account would require disrupting its service. The browser driver verifies both Retry callbacks in both themes. Screen integration is also exercised by SidebarView/DesktopRoomInspector tests.

## Repeat

From apps/mobile, generate Android with `npx expo prebuild --platform android --no-install`. In generated android/app/build.gradle, point react.entryFile at `../../scripts/quiet-row-actions-native-proof.tsx`; disable expo.modules.updates.ENABLED in the generated manifest. Build from android with `NODE_ENV=production ./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64 --max-workers=2 -Dorg.gradle.jvmargs=-Xmx4g`. Generated Android files are not committed.

Use a corner-owned emulator from `beeline emulator -avd buzzy_api36 -no-window -gpu swiftshader_indirect`. Install the fixture APK, launch app.usebeeline/.MainActivity, and run `python apps/mobile/scripts/capture-quiet-row-actions-android.py <serial>` from the repository root. This proof used emulator-5562 (1080 × 2400, 420 dpi), Hermes, native Unistyles, SVG, keyboard provider and production fonts. No iOS proof was requested.

For web, from the repository root run `node --import tsx apps/mobile/scripts/render-quiet-row-actions-proof.mjs`, serve .verification/quiet-row-actions/after on localhost:18491, and run capture-quiet-row-actions-web.mjs with QUIET_ACTIONS_PLAYWRIGHT pointing at a temporary playwright-core installation's index.mjs. The web builder shims native device integrations; the UI components are the production source.

Validation: root typecheck and lint; mobile UI policy including its baseline gate; whole-tree inline-action design check; shared Button/ErrorBanner/row inset tests; affected composer, corner list, desktop inspector, connection, profile, repository, search, invite and schedule tests; design and calm lint. The inline Button tests verify a target of at least 44 points from meta line height and hit slop, variant colours, busy/disabled state, wrapping and accessibility labels.
