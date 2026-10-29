# Corner adb and wording-neutral refactors

Scope: corner brief revision 2, approved by lunchboxfortwo in message
`4af577f0eac95b5666a7126f3719aa14c3305e11c6cf2f22b29ad4ea79b0809e`.
No server producer wording changes are part of this repair.

## Reproduction CORNER-ADB-1

On squire, this corner initially exported `BEELINE_ANDROID_EMULATOR_PORT=5628`
and `ANDROID_ADB_SERVER_PORT=5630`, with no `ANDROID_SERIAL`. After
`beeline emulator -avd se_test33 -no-window -gpu swiftshader_indirect`, the
helper's kept record instead named `emulator-5554`. Once booted, `adb devices`
listed both `emulator-5554` and `127.0.0.1:5555` for that one guest. The helper's
extra TCP connection created a second transport, while the turn retained its
pre-lease emulator selection. Earlier turns could see an empty per-agent server.

The lease now owns the adb server at its console port plus two. The corner's
`adb` launcher resolves the helper's kept record on every invocation, including
when Android starts during the same turn. Later turns restore `ANDROID_SERIAL`,
the console port and the adb server port before launching the harness. Reusing
a guest does not add a TCP transport, and retained leases from earlier helpers
lose their duplicate TCP alias when they are reused or restored. The launcher reads the record without
checking the helper's PID inside the turn's private PID namespace.

Run the real installed SDK proof after `npm run build -w @beeline/body`:

```sh
npm run prove:corner-adb
```

It boots two guests with independent throwaway corner roots, keeps both running,
checks that each corner's `adb devices` lists exactly its own serial, checks
unqualified `adb get-state`, and verifies restored server/serial environment.
It stops both guests and their private adb servers on exit. On squire the proof
passed with `emulator-5562` and `emulator-5570` on adb servers `5564` and `5572`.
The hardware configuration and lease scheduling policy are unchanged.

## Reproduction SYSTEM-REFACTOR-2

The actual failed heads and their scanner failures were retrieved from GitHub:

| PR | Failed Checks run | Incorrectly locked dependency |
| --- | --- | --- |
| [3044](https://github.com/Beeline-Work/beeline/pull/3044) | [40814597414](https://github.com/Beeline-Work/beeline/actions/runs/40814597414) | An ordinary empty conversation reply became a new System wrapper |
| [3032](https://github.com/Beeline-Work/beeline/pull/3032) | [40719372787](https://github.com/Beeline-Work/beeline/actions/runs/40719372787) | A Registry selection predicate pulled the company catalog into displayed wording |
| [3034](https://github.com/Beeline-Work/beeline/pull/3034) | [40719296398](https://github.com/Beeline-Work/beeline/actions/runs/40719296398) | Moving member wake routing changed a query's transitive wrapper inventory |
| [3050](https://github.com/Beeline-Work/beeline/pull/3050) | [40817788138](https://github.com/Beeline-Work/beeline/actions/runs/40817788138) | GitHub token caching changed repository-onboarding wording fingerprints |

Replaying the archived source of the first head with the original scanner
reproduced `DaemonService.execute:wrapper:696e6d583f900007`, matching its CI
failure. The source fixtures retain all four head SHAs and the affected source
or excerpts; they replay the refactors through the same scanner/enforcer CI uses.
The current dependency graph supplies unchanged collaborators so the fixtures
need no GitHub connection or repository history in CI.

```sh
npm test -w @beeline/server -- --run src/system-messages-lock.test.ts
```

The lock compares ordered wording fingerprints and total producer counts,
independent of filenames and enclosing function names. Type annotations are
not displayed. SQL parameters used only to select rows do not make upstream
callers into wording wrappers; projected phrase parameters remain tracked.
Proven array selection predicates and GitHub request authentication are data
selection/transport, while emitted literal phrases and formatter return values
remain locked. An explicit ordinary conversation reply stays outside the System
wrapper inventory; System/card writes inside its implementation stay scanned.

The lock inventory is regenerated for the scanner change, with existing approval
comments retained. Regression cases accept moved producers, local renames and
reformatting, and reject changed literal wording, changed expression operators,
reordered/repeated phrases, visible card changes and forwarded SQL phrase changes.

The review follow-up for SYSTEM-REFACTOR-2 reproduced a false pass when
`['hello','world'].find(word => word === 'hello')` changed its predicate to
`word === 'world'`: the displayed verb changed from `hello` to `world`, but
`enforce` accepted it. The same bypass reproduced for `filter` and `sort`.
Selection callbacks are now retained for local literal arrays, including aliases,
spreads and typed helper returns. Negative fixtures exercise those paths through
the same scanner and enforcer, while the four archived refactor fixtures must
continue to pass. The inventory is regenerated for the stricter callback dependencies
from unchanged producer source. Opaque provider/row arrays retain their data-only
treatment; request arguments do not become returned phrase-array dependencies.

The next review follow-up reproduced the same false pass through typed forwarding
parameters: `select(['hello','world'])` calls `forward(words).find(...)`,
`filter(...)`, or `sort(...)`. Each new regression failed on the previous head
because `enforce` did not throw for the changed callback. The scanner now follows
parameter inputs from resolved callers, including forwarding chains, before
classifying an array as opaque. These cases exercise the exact scanner/enforcer
path used by CI; no running application is involved in this check.
The stronger dependency tracking mechanically changes two wrapper fingerprints
(`ensureReviewDispatch` and `DaemonService.report`); the regenerated inventory
retains all producer source and visible wording unchanged.
