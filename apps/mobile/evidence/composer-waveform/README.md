# Separate Conversation entry

Feature work; not a defect report. Locked design: empty composer has Attach,
Message, mic, waveform; typed text replaces only waveform with Send. Both
slots retain their geometry. The waveform uses the microphone glyph family
and theme accent. The desktop button has the native browser title
"Conversation mode". Mic tap and long press retain their existing handlers.

## Desktop Chrome

Production react-native-web composer at 1280px, real bundled Space Grotesk,
Obsidian and Bone. Each of the four runs checks empty mic + waveform, hover
title, mic tap calling dictation only, waveform entry, mic long press without
an extra dictation, typed Send beside mic, and identical input width across
the swap. All seven checks pass in each run.

Screenshots: [Obsidian empty](desktop-obsidian-empty.png),
[Obsidian typed](desktop-obsidian-typed.png), [Bone empty](desktop-bone-empty.png),
[Bone typed](desktop-bone-typed.png).

## Android

Standalone Hermes release fixture rendering the production native composer,
real fonts and native text input on Android 36, 1080x2400. The emulator is
leased through `beeline emulator`; all adb commands target emulator-5558.
The fixture toggles both real Unistyles themes. Screenshots show the empty
and typed state in [Obsidian](android-obsidian-empty.png)
([typed](android-obsidian-typed.png)) and [Bone](android-bone-empty.png)
([typed](android-bone-typed.png)). Real `adb input text Hello` also exercises
native text entry independently of the fixture's Typed control.

The native driver captures Conversation entry and checks the fixture's join
counter after returning through End, because the live waveform prevents
UIAutomator from becoming idle. See [tap](android-conversation-tap.png),
[hold](android-conversation-hold.png) and [driver results](android-results.json).

## Scope of the demonstration

These fixtures stub the voice transport, account and provider. They prove
that the actual composer enters the existing Conversation UI, preserves
its shortcuts and swaps controls correctly; they do not re-prove live RTC
or agent audio. No Conversation behavior or dictation adapter changes.
Desktop capability comes from parent PR #2450 rather than a second
implementation. Mobile proof is Android only.

## Run

From apps/mobile:

```sh
npx vitest run sources/components/buzz/ConversationComposer.waveform.browser.test.ts
```

Native fixture: set the generated Android project's `react.entryFile` to
`../../scripts/composer-waveform-native-proof.tsx`, disable OTA in its generated
manifest, and build only x86_64 with two Gradle workers and a 4 GiB JVM heap.
Install the generated local APK on the leased emulator, then from the repo root:

```sh
python3 apps/mobile/scripts/composer-waveform-android-proof.py \
  --device emulator-5558 --out apps/mobile/evidence/composer-waveform
```

The driver's End coordinates refer to this fixture's 1080x2400 display.

## Reproduction waveform-tooltip-return

Chrome, both Obsidian and Bone: tap waveform → Conversation → End → hover
restored waveform. Before the fix the title was absent; all four Chrome
runs failed the restored-title assertion. The title effect now follows
Conversation visibility, so returning to the composer restores the title.
The same start/End/title assertion passes in all four Chrome runs.
