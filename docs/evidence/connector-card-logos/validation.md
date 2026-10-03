# Connector card logos and Instagram sign-in

Brief revision 1. Story: a person connecting Instagram from a connector card sees its service logo and reaches the same connection flow as Workbench.

## Reproduced

Reproduction CARD-1: connect Instagram or Figma through the agent's `connectApp`, read Workbench, then read the Room card. On the original code, Workbench has the provider logo and domain; the Room card has neither. Rendering the card also ignores supplied logo metadata and shows an initial. Both new server and mobile CARD-1 regressions failed before the fix.

The reported live first-attempt Instagram failure and native Instagram app handoff were **not obtained**. `adb devices` reported `emulator-5574 offline`. The reporter's account was not accessed. Server-backed tests and Chrome with a fixture provider were used instead.

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
