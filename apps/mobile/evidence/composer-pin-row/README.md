# Pinned call composer row

## Reproduction PIN-ROW-1

During an active call, pin an agent from the strip above the bordered composer.
The owner's Android attachment shows “Pinned to Sol” touching the left/top border
and Unpin clipped at the right edge. The old production composer browser fixture
also fails the horizontal inset, top padding and long-label containment assertions
in Bone and Obsidian at phone and desktop widths (eight failing cases).

The live owner call is unavailable in this isolated checkout. The closest stand-in
renders the production ConversationComposer and VoiceBar with a stubbed voice
transport: a native Android release fixture and react-native-web in real Chrome.
These demonstrate the layout and pin/Unpin path, without making an RTC claim.

## Demonstrated PIN-ROW-1

The caption and Unpin now use one InlineRow, with the controls' horizontal inset
and theme-token top padding. The label shrinks to a single ellipsized line;
Unpin keeps its shared Button minimum target plus hitSlop, with intrinsic width for larger text. Its accessible name and
the voice-pin-line test ID remain intact.

Chrome: Bone and Obsidian, narrow (390) and desktop (1280), short and long names.
All eight cases pass the geometry, pin/Unpin, active-call and attachment flow
assertions. The same assertions fail before the fix. Screenshots:

- [Before, phone](web-before.png)
- [Bone, phone](web-bone-390.png) · [long name](web-bone-390-long.png)
- [Obsidian, phone](web-obsidian-390.png) · [long name](web-obsidian-390-long.png)
- [Bone, desktop](web-bone-1280.png) · [long name](web-bone-1280-long.png)
- [Obsidian, desktop](web-obsidian-1280.png) · [long name](web-obsidian-1280-long.png)

## Repeat

From apps/mobile:

```sh
npx vitest run sources/components/buzz/ConversationComposer.conversation.browser.test.ts sources/components/buzz/VoiceBar.test.tsx sources/buzz/design-lint.design.test.ts sources/buzz/calm-lint.design.test.ts --maxWorkers=1
```

Native fixture: scripts/composer-pin-row-native-proof.tsx. Generate Android with
Expo prebuild, set the generated app/build.gradle entryFile to that script,
disable expo.modules.updates.ENABLED in the generated manifest, and assembleRelease
with x86_64, two Gradle workers and a four-GiB JVM heap. Use --no-daemon to avoid
sharing a daemon from another isolated checkout. Install only on the leased
emulator. Generated native projects and APKs are not committed.

## Android evidence

The isolated release/Hermes fixture runs on a leased Android emulator
(1080x2400, density 420). It renders the actual agent strip above the actual
bordered composer, using real fonts and both actual Unistyles themes.
UIAutomator cannot become idle during the waveform animation; the capture
driver uses screenshot-verified fixture coordinates. Chrome separately asserts
exact geometry and interaction. The native captures also show Unpin clearing
the row and a larger-text long-name state.

- [Obsidian, short](android-obsidian-short.png) · [long](android-obsidian-long.png)
- [Bone, short](android-bone-short.png) · [long](android-bone-long.png)
- [After Unpin](android-unpin.png)
- [Larger text, long name](android-large-text-long.png)

```sh
python3 apps/mobile/scripts/composer-pin-row-android-proof.py --device emulator-5554 --out apps/mobile/evidence/composer-pin-row
```

## Impeccable critique

[The scoped visual critique](critique.md) uses a sequential fallback because
no isolated sub-agent tool is available. Its initial screenshot pass found
larger-text Unpin truncation and insufficient Bone contrast for its old accent
ink. The target now grows with text, and secondary ink gives the quiet action
readable contrast. The proof harness also follows the real theme across Android
text-size recreation. The mechanical detector reports no findings.

Validation: root typecheck; UI component policy including the origin/main
baseline; voice control tests; design/calm lints; browser geometry and user-path
proofs in both themes, widths and name lengths; Android release build and captures.
