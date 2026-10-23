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

## Demonstrated

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

## Long-operation evidence still needed

Production Fly logs were read through the owner's vaulted credential. The native
Fly CLI had no login; Bearer-authenticated log reads returned 401. Fly's own client
uses the token's authorization scheme directly; that route returned 200.

The latest sampled buffer had 100 records and no duration records. A historical
sample from 2026-10-23 03:00:01.333206480Z through 03:02:43.139549668Z also had
100 records and no slow-operation/duration records. The source's slow-operation
logger records `phone.read_room`, not merge or repository-creation completion
durations. These samples do not establish worst-case times for either action.

The existing repository-card limit (60 seconds) and Workspace-deletion caller
limit (40 seconds, above the server's 30-second transaction deadline) are retained.
No measured merge/repository-creation maximum is claimed. Ruby needs to identify
an appropriate duration source or explicitly revise that evidence requirement
before this draft is ready for final review.
