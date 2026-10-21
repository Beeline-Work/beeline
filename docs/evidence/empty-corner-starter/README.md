# Empty corner starter

Feature, not a defect report. The approved user path is opening a corner,
seeing how to tag its first agent, and tapping to prepare the addressed message.

## Findings

Both transcript layouts previously showed `EmptyLedgerState` only when the
transcript had zero rows. The new eligibility also allows typed `corner-opened`
and `workflow-handoff` rows, preserving their display if delivered to the
transcript. The first conversation message hides the prompt; agent viewers never
see it. Room and DM empty-state eligibility and copy remain unchanged.

The real local create-with-+ path writes two system cards to PostgreSQL, but the
current server Room DTO returns `messages: []` for that fresh corner. Thus those
cards do **not** suppress the empty state on this demonstrated path. The
system-rows-only browser regression separately covers those rows being present
in the display transcript. `local-opening-records.txt` records the underlying
cards; `local-room-read.json` records the actual DTO message count.

## Demonstrated: CORNER-START-1 (focused browser stand-in)

Run from the repository root:

```sh
npm run test --prefix apps/mobile -- --run sources/test/empty-corner-starter.browser.test.ts sources/components/buzz/EmptyLedgerState.test.tsx sources/buzz/composer-fill.test.ts
```

The browser proof builds the actual `EmptyLedgerState` and the production chat
surface's first-agent selector, composer fill callback, corner tap callback,
eligibility expression and empty-state JSX. It supplies a local roster and
opening/handoff rows; network, navigation and the rest of the chat screen are
outside this proof. Chrome runs it at 390px and 1180px.

Observed passing results:

- The first agent with a handle is Beebee, after a person and before another agent.
  Opening/handoff rows still allow “Tag @beebee to start”.
- Tapping fills `@beebee `, focuses the input and registers Beebee's pubkey in
  both mention maps.
- Tapping with “Keep my thought” already drafted preserves that text, focuses
  the input, and does not register an unrelated mention.
- With no agent, the fallback reads “Tag an agent to start”; tapping focuses
  without inserting text.
- Agent viewers and a corner containing a conversation row have no prompt.

`web-390.png` and `web-1180.png` show this focused renderer after those taps:
empty composer filled, existing draft preserved, no-agent fallback focused.
These are component/surface-slice screenshots, not full signed-in app evidence.

## Real local stack (brief revision 2)

Production reviewer-bypass verification was replaced by local-stack acceptance
in brief revision 2. The local server uses a fresh migrated PostgreSQL database
`jellybean_corner_start_r2`, development auth and no production connections.
The disposable `local:cornercaptain` identity signs in through
`POST /v1/auth/github/exchange`. A real Workspace and #general were created
through the phone API, with a seeded local Beebee identity and agent membership.
No helper is attached and no agent turn is dispatched.

Desktop Expo web runs on port 18432 against the server on 18431. A temporary
bootstrap exchanged the dev identity and populated browser/native session
storage before normal app startup; it is not part of the product change.
The product entry and package main were restored afterward.

The real desktop app (1279 × 936) was driven through #general → Corners → +.
It created `open-amber-corner`, showed “Tag @beebee to start”, and tapping that
note registered the visible @beebee composer chip. No message was sent.

- `desktop-01-corners.jpg`: Corners screen before +.
- `desktop-02-note.jpg`: new corner and note, before tapping.
- `desktop-03-composer.jpg`: note tapped, composer with @beebee.

Android inventory found three development-client APKs: runtimes 21, 24 and 37.
No runtime-39 development client was found in the owner’s home/state/cache or
temporary APK inventory. The newest available development client was installed:
`a9c406e6-a4cc-4767-befe-668f904af6b5/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
Its embedded `expo_runtime_version` is **37**, verified with aapt; the Expo
menu reports the current Metro app configuration’s runtime **40**, which does
not change the installed binary’s native runtime. APK SHA-256:
`f48c31a09f1e06c15864fa1e438b948cef21037a35579fa004efa4400fe60289`.

Metro on port 18433 serves this PR’s normal `index.ts` against
`http://10.0.2.2:18431`. Device logs report build/release SHA
`ec4ef66e09bf208a0a90d89854b13dac5ca7fa22` and the local server origin.
The runtime-37 binary successfully loaded this head and signed in locally.
For a fresh device, temporarily use a sign-in entry that synchronously registers
an Expo root, exchanges `local:cornercaptain` with the local server, and writes
the returned session through SecureStore. Then restore normal package main and
restart Metro before opening the real app. This avoids trying to register the
real app only after an asynchronous sign-in. Expo’s floating Tools overlay was
disabled in local dev-client preferences for the captures, without changing
native source.

The Android native app was driven through #general → Corners → +, creating
`hidden-atlas-corner` (`4d7eafdc-5596-4261-8dc2-eeddc8079a2f`). The note showed
“Tag @beebee to start”. Tapping it produced the @beebee mention chip, an active
caret and the Android keyboard. The accessibility tree reports the Message
field text `@beebee ` with `focused="true"`; InputMethodManager reports
`mInputShown=true`. No message was sent. The database contains two opening records
for this new corner while the Room read DTO returns no transcript messages.

- `android-01-corners.png`: native Corners before +.
- `android-02-note.png`: the new native corner and note before tapping.
- `android-03-composer.png`: after tapping, mention and keyboard visible.
- `android-composer.xml`: accessibility evidence of the focused Message input.

This is a real app/server demonstration, not the focused renderer stand-in.
The installed native runtime is 37, so it does **not** claim the brief’s exact
runtime-39 acceptance. Ruby accepted this runtime-37 proof in the revision-3 assignment because the
change is JavaScript-only; no runtime-39 client will be built.

## Validation

- `npm run corner:prepare`: passes.
- Root typecheck, mobile UI component policy and workflow-path lint: pass.
- Focused unit/composer/browser checks: 10 tests pass.
- Revision-2 full mobile run: **577 files pass, 4 skip; 4767 tests pass,
  5 skip; no failures** (581 files, 4772 tests).
- The earlier run’s unrelated viewer-dock failure passed in the isolated retry
  and in this full run.

## First-message prefill (brief revision 3)

The existing automatic reply rule is `answerPrefillCandidate` in
`apps/mobile/sources/buzz/composer-prefill.ts`, followed by `planAnswerPrefill`.
`BuzzChatSurface` applies its plan through `applyComposerPrefill` and registers
both mention maps. The extension supplies the Room/corner roster and offers its
sole agent before the viewer has sent a message. Room-scoped candidate ids reuse
the existing once-only guard, and the existing planner preserves any draft.
Agent viewers, DMs, and zero/multiple-agent first-message behavior stay unchanged.

The same local #general now contains only Beebee's seeded hello, with no human
message. `desktop-04-first-message.jpg` captures the real desktop app opening
that Room: the @beebee chip appears automatically without typing or tapping a
starter. The initial tag is offered even before the hello arrives; the stable
candidate prevents reinsertion after a person deliberately deletes it.

Unit cases cover an empty Room and a hello, two agents, no agent, an existing
draft, an agent viewer, deletion followed by a hello, and the normal answer rule
after the viewer has spoken.

First-message implementation commit: `d5923e63e`. The revision-2 native runtime-37 acceptance remains in force.

`android-04-first-message.png` captures the same real #general path on the
accepted runtime-37 client, with Metro reporting implementation SHA
`d5923e63eebcd4ea504b24041cf2c402c12758e4`. The Room shows Beebee's hello and the
@beebee composer chip automatically, without typing, tapping the note, or
sending a message. `android-first-message.xml` records the native input text.
`first-message-state.json` confirms one agent member and zero messages authored
by cornercaptain in #general.
The temporary native sign-in bootstrap was removed and normal package main and
`index.ts` restored before this capture; no native code changed.

Revision-3 checks: root typecheck, UI component policy and workflow-path lint
pass; the composer-prefill suite passes all 28 tests. The first full mobile run
passed 4773 tests with 5 skipped and one unrelated five-second timeout in
`DirectMessagePickerSheet.browser.test.ts`; that file passes both tests on its
isolated retry. A full repeat uses two workers and one retry. Current-head CI
must pass before this PR leaves draft; final results are recorded in the PR.
