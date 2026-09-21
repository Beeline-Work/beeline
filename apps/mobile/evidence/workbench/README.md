# Workbench UI evidence

Captured on a real Android emulator (API-level dev build, app.usebeeline) from this
branch. The server-side Workbench API (PR 2) has not landed yet, so the screens read
the mocked `WorkbenchSource` (`sources/buzz/workbench-source.ts`) with per-viewer data
(`human-dani` has the Vercel and Google connections; `human-terra` has none).

| file | shows |
| --- | --- |
| workbench-settings-dani.png | Settings route: Connectors (Trusty Squire connect / Wallet, Tailscale soon) + member A's connections |
| workbench-settings-terra-empty.png | Same screen for member B: none-yet empty state, no leakage of member A's connections |
| workbench-settings-dani-connected.png | Trusty Squire row showing `connected` after pairing |
| workbench-connect-helpers.png | Connect flow: helper picker, offline helper marked, "pair a helper, not an agent" note |
| workbench-connect-failed-step.png | Failed install step in red with reason and Retry |
| workbench-connect-signin.png | Install paused at "waiting for sign-in" with the `Sign in to Squire · streamed page` row |
| workbench-connect-signin-browser.png | Tapping Sign in opens exactly the relayed URL (login.example-squire.test) in the browser |
| workbench-connection-vercel.png | Connection detail: hosts, created by, grants with kinds, spend cap, ledger |
| workbench-connection-revoke-confirm.png | Revoke confirmation prompt |
| workbench-connection-revoked.png | After confirming: `Revoked 2 grants` line |
| workbench-two-backs-before.png | v0.0.104 fault: the screen's own ‹ header row stacked under the navigator's back control, plus the four-line Keys empty state |
| workbench-polish-after.png | After the fix: one stack-header back control, Workbench title, and the two-line Keys empty state |
| workbench-keys-before.png | v0.2.20 key rows: no leading mark, the vault kind ahead of the host in the quiet line, a bare state word, and the Tools head sitting 16 from the top against the Keys head's 24 |
| workbench-keys-after.png | After: the company mark leads the row, the domains are the quiet line (a hostless key has none), the state word carries its dot, and both heads take 24. The third key is the review case — `Work key`, no hosts, vault service `github` — whose mark reads `G` from the service, not `W` from the label |
| workbench-key-error-before.png | A key whose vault reports `error` read in the same quiet grey as a live one, with no dot |
| workbench-key-error-after.png | The same key reading broken: the failed dot and the danger tone the tool rows already use |

Note: the DM connector receipt card is covered by render tests in
`chat/RoomMessageVariants.test.tsx` (no live DM backend available on the emulator).

The four `workbench-key*` captures are not emulator shots. A key row only exists
once a Trusty Squire vault holds a credential, which this host cannot provision,
and the emulator's dev build has no server to sign into — so the screen module
itself (`settings/workbench.tsx`, its real styles, the shipped Space Grotesk
faces) was painted under react-native-web at 393×520 CSS px, device scale 2,
reading the same `MockWorkbenchSource` the render tests read. The error pair
flips the Google key's state to `error` in that mock and changes nothing else.
The `before` pair predates the mock's third key (`Work key`), which was added
with the fix that made the mark read the vault's service.
