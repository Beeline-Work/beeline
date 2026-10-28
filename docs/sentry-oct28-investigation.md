# October 28 Sentry investigation

This is a partial remediation, not a claim that all four incidents are fixed.
The owner-vault alert setup token successfully read the events through Squire
`use_credential`; no token was exported. Releasing or resolving issues is separate
from merging this work.

| Issue | Evidence and disposition |
| --- | --- |
| [7815208089](https://beeline-bt.sentry.io/issues/7815208089/) | One Android fatal event on October 27 at 17:37 UTC. Its symbolicated stack contains only Reanimated's settled-props collector and React internals, with no Beeline component or screen. The installed lockfile resolves Reanimated to 4.5.3. No animation change is justified yet. |
| [7814946337](https://beeline-bt.sentry.io/issues/7814946337/) | The `fill` function and its callers are all `app:///<anonymous>` frames, with no source context or page identity. Repository searches found no production DOM-writing `fill` implementation. This alone does not establish artifact provenance, so no Sentry filter or guessed null guard was added. |
| [7815286653](https://beeline-bt.sentry.io/issues/7815286653/) | The operator System DM job exhausted connection retries before its transaction callback ran. Its durable queue can retry on the next loop. The first such failure now warns locally; consecutive failures still reach Sentry at error level. Any failure after the callback starts, and every other job's failures, remain immediately reportable. The event does not establish whether production recovered on the next loop or whether the pool was exhausted. |
| [7797855787](https://beeline-bt.sentry.io/issues/7797855787/) | All three available events (October 17 at 19:03 and 19:04 UTC, October 27 at 13:18 UTC) contain only the deadline timer stack, without a request or job tag. This is insufficient to identify the transaction or call it a one-off. Deadlines now preserve the transaction entry caller stack while retaining the same timeout, client destruction, and error code. This is diagnostic remediation; the underlying slow operation remains unidentified. |

The upstream [settled-animation crash report](https://github.com/software-mansion/react-native-reanimated/issues/8816)
and [fix](https://github.com/software-mansion/react-native-reanimated/pull/8822)
describe a native missing-key exception, not this event's React update-depth
exception. They do not establish that upgrading or disabling the feature fixes
this incident. Avoid an app-wide animation change without a matching reproduction.

## Reproduction attempts

- Booted `buzzy_api36` with `beeline emulator -avd buzzy_api36 -no-window -gpu swiftshader_indirect`.
  ADB confirmed boot completion. Package inspection found no Beeline or Expo app,
  and the checkout contained no APK. No affected screen is named by the event.
  The native freeze has not been reproduced.
- Playwright with host Chrome loaded `https://web.usebeeline.app`, which redirected
  to `/beeline/onboarding`, with no page errors. An initial attempt at
  `app.usebeeline.app` failed DNS; repository deployment configuration supplied
  the correct `web` hostname. The anonymous `fill` crash has not been reproduced.
- Existing artifact tests confirm script-disabled markup views and an opaque
  runnable iframe (`allow-scripts` without `allow-same-origin`); native runnable
  views have no message bridge or injected script. Passing isolation tests do
  not identify the source of the anonymous event.

## Reproduced and demonstrated

`R-SENTRY-CONNECT`: a queued operator notice → force every connection checkout
retry to time out → the job fails before delivery. Previously even this first
deferral was captured as an error. Now the queue remains pending, one local
warning records the deferral, the next loop commits delivery, and the recipient's
`PhoneService.readRoom` returns exactly one System notice. A second failed loop
and failures during transaction work still capture errors. Recovery resets the
consecutive-failure counter.

Run `npm test -w @beeline/server -- src/background-database-recovery.test.ts src/operator-system-dm.test.ts`.
The delivery test uses an isolated PGlite database and a forced `pg` pool checkout
failure; it does not claim to reproduce production network or pool conditions.
For the compiled service path, run `npm run prove:operator-system-dm`.

`R-SENTRY-DEADLINE`: start a transaction whose callback never settles → expire
the deadline → destroy its client and reject. Previously the stack identified
the timer; now it identifies `overrunTransaction`, with code `57014`, and active
transaction bookkeeping clears. This stand-in verifies diagnostics and cleanup,
not a fix for the unidentified production transaction.

With the original base versions of `background.ts` and `database.ts`, the new
regression suite failed its first-deferral, repeated-failure capture-count, and
deadline-caller assertions. Restoring the implementation passes all four tests.
The existing database/background suites pass (97 tests), the operator delivery
and new recovery suites pass (13 tests), and the artifact isolation suites pass
(28 tests). Root typecheck and the compiled operator proof also pass.

## Remaining evidence

The affected phone screen and repeatable steps, plus the page or evaluated script
containing `fill`, are needed for targeted mobile fixes. A future transaction
deadline captured with its caller stack can identify the slow operation. Keep
these three issues open; only the operator checkout noise has a supported
behavioral fix here. Do not resolve any issue before an applicable release.
