# Waiting actions: Reproduction R1

The client now bounds the full operation (authorization, headers and body), even
when the native transport ignores abort. Ordinary writes use 20 seconds; existing
15-second read/repeatable-write limits and explicit longer caller limits survive.
Both phone-operation entry points share this boundary.

The corner sheet remains dismissible during Close and ignores retired requests'
late navigation/error callbacks. Profile Back remains available while Message
waits, the shared Button shows its loader immediately, and a late DM cannot
navigate after the profile has closed. Timeout errors say the result is unknown;
the affected screen refreshes before the person retries.

GitHub, object storage and the remaining raw server fetch calls use
`externalFetch`. The source guard scans the authentication and server directories
for raw fetch and named HTTP-client calls without an explicit signal. The guard,
registry-driven client tests and both Back component tests run in SHARED PACKAGE
TESTS on every pull request.

## Reproduced

Baseline: `b5e800481295b6a6a164419583a76bca9331a66c` (main when work started).

```sh
python3 scripts/prove-operation-deadlines-before.py --baseline b5e800481295b6a6a164419583a76bca9331a66c
```

The script temporarily restores the baseline production files, keeps the new
regressions, and restores the edits in `finally`. For the corner component it
renders the baseline's exact sheet JSX and close handler in a narrow harness;
it does not substitute a newly invented old implementation.

Captured failures in `before-client-and-back.txt` include:

- Close corner Back: expected onClose once, got zero calls.
- Cancel disabled and backdrop dismissal disabled during Close.
- Profile header Back: expected onClose once, got zero calls.
- Profile system Back: late DM navigation still runs after unmount.
- Registered operations have no limit, or never leave a nonresponsive transport.

`before-outside-calls.txt` identifies raw unbounded GitHub, storage and server
fetch calls. The complete before output and passing output are checked in beside
this file.

## Demonstrated: signed-in Android R1

The complete normal app (`apps/mobile/index.ts` unchanged) ran on a leased
Android API 36 emulator, signed in through the existing local review login.
It used the actual monolith, PostgreSQL fixture, Room/corner and profile screens;
no operation or transport mock was installed. The existing latency-rig proxy ran
on the host and the app connected through `10.0.2.2`. Only disposable local data
was changed. This is a development native build of the real app, not the
standalone component proof below.

Open the disposable corner, open its actions, enable airplane mode, tap Close.
The native error alert appears and OK allows retry. Open the fixture person's
profile, enable airplane mode and tap Message. The operation times out, displays
the unknown-result message and enables Message again. Separate attempts delay
host responses (10 second proxy RTT), tap the action, enable airplane mode and
press Back while it waits: hardware Back for the corner sheet, header Back for
the profile. Both leave their pending surface.

| R1 path | Captured result | Observation upper bound |
| --- | --- | --- |
| Close offline | [Error and retry](signed-in-android/close-offline-error-result.png) | 3.06s |
| Message offline | [Unknown result and retry](signed-in-android/profile-offline-error-result.png) | 22.25s |
| Close waiting, hardware Back | [Pending](signed-in-android/close-back-pending.png), [dismissed](signed-in-android/close-back-result.png) | 2.45s |
| Message waiting, header Back | [Pending](signed-in-android/profile-back-pending.png), [left](signed-in-android/profile-back-result.png) | 2.56s |

The JSON receipts beside the screenshots measure from tap through screenshot and
UI Automator inspection. Those inspections add roughly (2 seconds); these are
observation bounds, not measured timer or navigation latencies. The Message
operation has the (20 second) timer, also exercised directly with fake timers.
A dropped network may fail immediately instead of waiting for the deadline.
The native standalone proof below separately observes the (20.0 second) deadline.

Capture runner (open the named signed-in surface online first):

```sh
python3 scripts/prove-operation-deadlines-android.py --device emulator-5554 --surface close --mode offline-error --out apps/mobile/evidence/operation-deadlines/signed-in-android
```

Repeat with `--surface profile` and `--mode back`. Back mode uses the existing
local latency proxy. The fixture may complete an accepted action after Back; a
previous delayed attempt did archive this disposable corner. Dismissal retires
late UI callbacks, not server authority. Component regressions separately assert
that resolving a retired request cannot navigate or reopen the surface.

## Supporting native transport proof

`operation-deadline-native-proof.tsx` mounts the production CornerActionsSheet,
shared controls and monolithPhoneOperation in a disposable Android development
build. A transport that never settles and ignores abort models the offline native
stall. Open corner actions, tap Close corner, then enable airplane mode. A separate
attempt presses Android hardware Back during the wait.

- `android-waiting.png`: the production sheet acknowledges Close immediately.
- `android-timeout.png`: unknown-result error after 20.0 seconds; retry is available.
- `android-back.png`: Back immediately dismisses the waiting sheet.

This is an isolated native component/transport stand-in, not a signed-in full-chat
production run. No real corner was archived. Profile Back and late-result handling
are demonstrated by rendered component tests, not an Android profile recording.
The normal app entry is restored; the proof entry is opt-in only.

To rerun, temporarily import `./scripts/operation-deadline-native-proof` from
`apps/mobile/index.ts`, run Metro for the Android development client and restore
index.ts afterward. Use a leased disposable emulator, not a person's phone.

## GitHub budgets

[Call counts, source lines and client budgets](github-call-budgets.md) use
GitHub's documented REST processing cutoff. GitHub calls allow (15 seconds);
ordinary other providers allow (20 seconds). Repository creation allows
(60 seconds). Merge allows (540 seconds) for its longest queue recovery path,
including existing bounded read retries. No production timing logs were added.
