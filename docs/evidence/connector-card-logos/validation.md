# Connector card logos and Instagram sign-in

Brief revision 1. Story: a person connecting Instagram from a connector card sees its service logo and reaches the same connection flow as Workbench.

## Reproduced

Reproduction CARD-1: connect Instagram or Figma through the agent's `connectApp`, read Workbench, then read the Room card. On the original code, Workbench has the provider logo and domain; the Room card has neither. Rendering the card also ignores supplied logo metadata and shows an initial. Both new server and mobile CARD-1 regressions failed before the fix.

The reporter's exact historical first-attempt failure and native Instagram app handoff were **not obtained**. Initially, `adb devices` reported `emulator-5574 offline`. Initial validation used server-backed tests and Chrome with a fixture provider. Subsequent authorized diagnostics narrowed the failed attempt to the verifier return, and the now-reachable emulator reproduced the missing recovery surface as RETURN-1 below.

## Demonstrated

Reproduction CARD-1 now passes for Instagram and Figma. Current Room reads, historical pages, and the phone contract decoder preserve the same provider logo and domain that Workbench uses. The real card renderer requests that logo, then falls back to a domain favicon and finally a letter if both images fail. Existing stored cards receive metadata at read time; no reissue is required. Metadata failure or a stalled request leaves the card and its sign-in action usable, within the existing one-second optional enrichment deadline.

Chrome rendered the production `AppSignInCard` export, its styles, `AppMark`, and `openAppSignIn` with React Native Web, backed by this branch's `PhoneService` and `DaemonService` and an isolated PGlite database. An esbuild harness selected that export and its styles directly from `RoomMessageVariants.tsx`; it omitted unrelated transcript components and supplied the existing theme through a Unistyles shim. The fixture provider supplied a locally served Instagram favicon downloaded from Google's public favicon service. Screenshots use fallback browser fonts and are evidence for the logo and action, not a full app screenshot.

At 393px and 1280px, the image loaded rather than an initial. Clicking Connect Instagram opened the server-issued URL in a new browser page. The fixture provider completed the first callback, and reloading the card showed `INSTAGRAM CONNECTED · BEE CONTINUES`. Captures: [phone](card-phone.png), [desktop](card-desktop.png), [connected](card-connected.png).

SIGNIN-1 is a regression, not a reproduction of the intermittent live failure. Both initial connection routes issue exactly one Instagram link for the same owner/toolkit and complete successfully. The card route also settles its original card and resumes the original request. Both UI routes already call `openAppSignIn`, which delegates to the platform opener. No service-specific deep link is constructed by either route. A browser fixture cannot verify native Instagram app launch.

The existing [PR #2007](https://github.com/Beeline-Work/beeline/pull/2007) already handles provider-reported Instagram failure reasons and pending-sign-in timeouts. Its OAuth-1 and OAuth-2 regressions passed on this branch. This does not establish the cause of the reporter's intermittent failure; no speculative authentication change was made.

## Validation commands

```sh
BEELINE_SIGN_IN_PROOF=1 npm test -w @beeline/server -- src/app-connections.integration.test.ts
npm test -w @beeline/server -- src/composio-apps.test.ts
npm test -w @beeline/server -- src/phone-service.read-room-latency.test.ts
BEELINE_SIGN_IN_PROOF=1 npm test --prefix apps/mobile -- --run 'sources/app/(app)/beeline/chat/RoomMessageVariants.test.tsx' 'sources/app/(app)/beeline/settings/workbench/app.test.tsx' 'sources/app/(app)/beeline/settings/workbench/connect-app.test.tsx' sources/utils/open-external-url.test.ts
npm test -w @beeline/api-contract -- src/phone-guards.tolerance.test.ts
npm run build -w @beeline/server
npm run typecheck -w @beeline/server
npm run typecheck --prefix apps/mobile
git diff --check
```

App connections: 39 tests passed. Mobile: 118 tests passed. Contract: 140 tests passed. Composio: 25 tests passed. Room latency: 10 tests passed when run separately; the first combined run exceeded its 1200ms timing assertion at 1273ms, and the separate run measured 1193ms. Server build and server/mobile typechecks passed. The corrected SIGNIN-1 fixtures set the provider account active before completion; both pass.

Fallback remains a letter when neither a bundled image, provider logo, nor a working domain favicon is available. No new per-service logo table, authentication route, authorization change, or connection flag was added.

## CI follow-up

Reproduction CI-1: BODY SUITE job 111089163023 failed in the inherited `squire-broker-squatter.test.ts:104` assertion. Socket reclamation returned the expected successful result, but the immediate child `exitCode`/`signalCode` assertion was still false. The implementation waits for process/socket release through `/proc`; Node's child exit notification can arrive after that observation. The test now awaits that notification before asserting exit and SIGKILL status. The assertions remain in place and the existing test timeout still bounds the wait. No broker implementation changed.

The unmodified seven-test file passed locally using `TMPDIR=/tmp`. The helper's default temporary path is too long for Unix sockets. GitHub rejected rerunning the completed job because its encompassing workflow was still running. The CI correction is limited to test synchronization.

After the correction, `TMPDIR=/tmp npm test -w @beeline/body -- src/squire-broker-squatter.test.ts` passed all seven real-process/socket tests, including the exact failed test and SIGKILL case. `npm run typecheck -w @beeline/body` and `git diff --check` passed.

## Authorized live investigation

The reporter authorized reading the failed sign-in diagnostics in Room message `a4bc2ec42c8c88be13a834fb322ffca2d3e9c2dd592a1387dba691bf873c9698`. This authorizes investigation; it does not change brief revision 1 or clear reviewer blocker R-1.

On 2026-10-03, a read-only PostgreSQL transaction through the server's Fly Machine inspected only the reporter's Instagram app, sign-in cards, route history, and the initiating report timestamp. A provider GET filtered by that same owner and the Instagram toolkit inspected account status metadata only. No account tokens, provider credentials, sign-in URLs, or other users' records were returned; no production data was changed.

The retained timeline, in UTC:

- The Instagram app and its single Composio route were created at 2026-10-02 20:54:07.643.
- Its only retained sign-in card was created at 21:03:49.008 and now has status `connected`, with no retained `errorMessage`.
- Composio returned exactly one account, created at 21:42:33.045 and updated at 21:42:51.568, with status `ACTIVE` and no `status_reason`. No failed first account was returned.
- The app was updated at 21:42:51.607, has no pending-link expiry, and has no retained `sign_in_error`.

These observations establish the successful later connection, not the cause of the first failure or whether the native Instagram app opened. `beginComposioAppSignIn` deletes the previous provider account before requesting a fresh link, so the surviving account is insufficient to diagnose the earlier attempt.

At this read, both running Fly Machines reported release `0.1.5-b4dfec78cc47`, which predates PR #2007's failure reporting. This is deployment evidence, not proof that #2007 fixes the reporter's original cause. The initial Fly app-log request returned HTTP 401; Jellybean subsequently corrected the authorization header and read the logs. The following evidence supersedes that access blocker.

## Verifier return recovery

Story: a person who finishes Instagram sign-in sees an Open Beeline action if the automatic return does not open the app.

Jellybean's scoped log read, recorded in Room message `deeab0e560a6542009d899d9931b477307c66f8afd2ed74b9b9976a143290bdd`, found that the connector card called `beginAppSignIn` at 21:03:54 UTC and reached `/v1/apps/oauth/verify` at 21:04:18, with no following phone completion call. The later Workbench attempt reached the verifier and completed on the phone at 21:42. This locates the missing completion at the verifier-to-phone handoff. It does not identify the browser's rejection reason or prove whether Instagram's own native app opened.

Reproduction RETURN-1: run the branch's built `createBeelineServer` on port 4190 with isolated database/auth stubs, forward that port to Android Chrome, temporarily disable the installed Beeline app handler, and open the verifier callback with `session_uri=return-fixture`. Before the change, the endpoint returned only a 302 to the app scheme with an empty body. Chrome stayed on a blank page with no recovery link. [Before capture](verifier-before.png).

The verifier now responds with a small HTML page that tries the same Beeline app URL automatically and always provides an Open Beeline link carrying the original session. It does not redeem or activate the connection anonymously. The page remains available when the automatic handoff is blocked or scripts are disabled; it has no external resources, uses nonce-bound script/style policy, and retains no-store/no-referrer headers.

Reproduction RETURN-1 now passes against the built change on `emulator-5574` in Android Chrome. With the app handler unavailable, the page displayed Open Beeline instead of remaining blank. Re-enable the handler and tap that action: Android's top resumed activity became `app.usebeeline/.MainActivity`, with the exact `beeline://beeline/settings/workbench/connect-signin?appSignInSession=return-fixture` intent. The same page also opened Beeline automatically with the handler available. [Recovery page capture](verifier-recovery-phone.png). The installed Beeline binary was version 0.2.21; the changed server response came from this branch's built service. Its fixture account could not complete a real provider session and displayed Network request failed. This phone proof establishes the app handoff, not a real Instagram authorization.

Playwright in headless Chrome rendered the built verifier at 393px with scripts enabled and disabled; in both cases the recovery link was visible and contained the unchanged session. Initial desktop Chrome startup failed because the helper's temporary directory exceeded the Unix socket path limit; `TMPDIR=/tmp` resolved it. A navigation wait for full load timed out during the attempted external handoff; waiting for the HTTP document commit allowed the visible fallback to be measured. Connecting Playwright directly to Android Chrome timed out, so native proof used adb's UI hierarchy, screenshots, and activity intents instead.

The SIGNIN-1 integration cases now exercise the real public verifier HTTP response and authenticated phone HTTP completion for both connector-card and Workbench entry. The fallback preserves the first session, anonymous completion returns 401 without calling the provider, authenticated completion connects the original account, and the card settles/resumes its original request. Each case issues only one provider link. The first fixture run used a phone token below the existing bearer length floor and received 401; correcting the fixture token made both cases pass without changing authorization code.

Follow-up validation:

```sh
npm test -w @beeline/server -- src/server.test.ts
BEELINE_SIGN_IN_PROOF=1 npm test -w @beeline/server -- src/app-connections.integration.test.ts src/composio-apps.test.ts
BEELINE_SIGN_IN_PROOF=1 npm test -w @beeline/server -- src/app-connections.integration.test.ts -t SIGNIN-1
npm test --prefix apps/mobile -- --run 'sources/app/(app)/beeline/settings/workbench/connect-signin.test.tsx'
npm run build -w @beeline/server
npm run typecheck -w @beeline/server
git diff --check
```

47 server HTTP/live tests passed. The existing 39 app-connection and 25 provider tests passed before expanding the two SIGNIN-1 cases; both expanded cases then passed separately. Six mobile callback tests passed, including Room/Workbench routing after verified completion and failure remaining on the callback screen. Server build, typecheck, and diff check passed. The historical browser rejection reason and Instagram-native-app launch remain unrecorded; the reproduced unhandled Beeline return is fixed without a second connection attempt.
