# Trusty Squire reconnect proof

Reproduction ids: `squire-false-card`, `squire-spinner`.

## False reconnect and attribution

The HTTP integration scenarios in `apps/server/src/integration.test.ts` start an isolated PGlite server, report an already-connected machine, and post the same `postSquireLoginWall` operation used by the agent tool.

- On main, `oauth_sign_in` posts a reconnect card and queues installation. With the fix, `oauth_sign_in` and `awaiting_human` post no card and queue no reconnect.
- On main, a `google_session` wall stores the raw tool text and the owner as acceptor before any tap. With the fix, the card and message contain fixed Google sign-in wording. Completing the helper install and vault report without a human tap settles the card as automatically reconnected and resumes the paused turn.
- `workbench.integration.test.ts` exercises the phone's `readWorkbench` HTTP operation with a connected broker report and an active reconnect. The returned machine says `Reconnecting…`, even though its previous broker report is connected.

## Spinner paths

No authenticated phone/emulator session was available (`adb devices` listed none). The original production sign-in tunnel failure was not reproduced. The closest isolated stand-in is a real web build of the affected React screens, with the install read deliberately never resolving. It uses the actual observer, timer, route helper, and screen code, with only host services mocked.

Run from `apps/mobile`:

```sh
npx vitest run sources/test/squire-reconnect.browser.test.ts --maxWorkers=1 --minWorkers=1
```

The browser scenario runs at 390 px in both Obsidian and Bone:

1. Tap Continue sign-in on the rendered in-chat Squire card → route helper → sign-in screen. On main, the route targets the installation screen and the rendered sign-in has no retry after 16 seconds. With the fix, it targets `connect-signin`, displays Google sign-in wording, and shows an error and Retry within 15 seconds when the read hangs.
2. Settings → Trusty Squire → selected computer → Reconnect's destination (`connect`, with its helper id). On main, after 17 seconds the page still says pairing automatically without an error. With the fix, the failed read shows a connection error and Retry.

`connect-signin.test.tsx` also exercises the existing helper ceremony through a reported sign-in URL and connected completion. The new regression retries a hung read, while the existing tests retain the missing-install recovery and ceremony completion checks. A loaded sign-in page that never completes also has a bounded two-minute wait before an error and Retry.

## Account and actions

The computer row renders the server's account/status. Reconnecting disables its action and removes Disconnect from an already-open sheet. Healthy connected machines retain Disconnect. The helper preserves an email supplied by Squire's connect report; opaque account ids are not presented as Google email addresses. Older reports without an email show `Google signed in` rather than inventing an account.

The regression tests were run against the unchanged `origin/main` implementation, then against the fix. Main failed the OAuth suppression, fixed copy, direct route, account/state rendering, attribution, and bounded-wait regressions. `awaiting_human` suppression already passed on main and remains covered.
