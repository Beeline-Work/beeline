# Empty corner starter

Feature, not a defect report. The approved user path is opening a corner,
seeing how to tag its first agent, and tapping to prepare the addressed message.

## Findings

Both transcript layouts previously showed `EmptyLedgerState` only when the
transcript had zero rows. `corner-opened` system rows and `workflow-handoff`
cards survive the server-message presentation projection, so a fresh corner
with only those records had no starter. The prompt now appears alongside those
records. The first conversation message hides it; agent viewers never see it.
Room and DM empty-state eligibility and copy remain unchanged.

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

## Outstanding real-target verification

The requested native Android create-with-+ path and reviewer-bypass browser path
have not been demonstrated. The leased Android emulator booted, but contained
no Beeline installation. The APKs found under temporary OTA-test directories
were test fixtures; an attempted install was rejected as not an APK. A broader
search also found prior-corner APKs, but none built from this head. The exact
Android acceptance still needs a build carrying this head and a signed-in session.

Trusty Squire opened production web in an existing lunchboxfortwo owner session.
The reviewer bypass exists in the vault as a sealed login-link value; the
mounted browser navigation route requires a plaintext URL and exposes no sealed
login-link navigation operation. No secret was retrieved, no corner/message was
created in that session, and no production rollout was attempted. This branch's
code is not deployed there.

Remaining acceptance: load this head in an Android development build and a web
preview, sign in through an authorized reviewer route, create a corner with +
in a Room containing Beebee, capture the note, tap it, and capture the focused
composer with @beebee. The focused proof above does not replace that acceptance.

## Validation

- `npm run corner:prepare`: passes.
- Root typecheck, mobile UI component policy and workflow-path lint: pass.
- Focused unit/composer/browser checks: 10 tests pass.
- Full mobile run: 575 files pass, 4 skip, 1 fails (4765 passing tests,
  5 skipped, 1 failing). The failure is the unrelated
  `ViewerConversationDock.browser.test.ts` top-scroll proof. Its isolated rerun
  passes all three tests. The full run is therefore not claimed green.
