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

Note: the DM connector receipt card is covered by render tests in
`chat/RoomMessageVariants.test.tsx` (no live DM backend available on the emulator).
