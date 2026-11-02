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

The former function/dependency fingerprint guard rejected these wording-neutral changes:

The actual failed heads and their scanner failures were retrieved from GitHub:

| PR | Failed Checks run | Incorrectly locked dependency |
| --- | --- | --- |
| [3044](https://github.com/Beeline-Work/beeline/pull/3044) | [40814597414](https://github.com/Beeline-Work/beeline/actions/runs/40814597414) | An ordinary empty conversation reply became a new System wrapper |
| [3032](https://github.com/Beeline-Work/beeline/pull/3032) | [40719372787](https://github.com/Beeline-Work/beeline/actions/runs/40719372787) | A Registry selection predicate pulled the company catalog into displayed wording |
| [3034](https://github.com/Beeline-Work/beeline/pull/3034) | [40719296398](https://github.com/Beeline-Work/beeline/actions/runs/40719296398) | Moving member wake routing changed a query's transitive wrapper inventory |
| [3050](https://github.com/Beeline-Work/beeline/pull/3050) | [40817788138](https://github.com/Beeline-Work/beeline/actions/runs/40817788138) | GitHub token caching changed repository-onboarding wording fingerprints |

The original scanner reproduced `DaemonService.execute:wrapper:696e6d583f900007`
on the first failed head. That inventory is now retired: code structure, producer
counts, predicates and expression operators are no longer wording fingerprints.

The current [System wording contract](agent-system-events.md) has two independent checks:

- `system-message-wording.lock.json` maps each catalog key to the SHA-256 of its
  exact template fragments. New keys, removed keys and wording edits require
  lunchboxfortwo's approval. Variable descriptions, declaration order and source
  formatting do not change the wording hash.
- `system-message-catalog.test.ts` follows System sink values through aliases,
  helpers, card serialization and SQL outputs, rejecting inline text outside the
  catalog. Dynamic names, provider responses and ordinary conversation text stay
  data; unrelated implementation edits do not need wording approval.

The same test suite renders every catalog key against pre-catalog output fixtures,
including whitespace, punctuation, Unicode and representative variable values.
Its source-scan regression inserts an unrelated diagnostic into
`DaemonService.postRoomMessage`, `PhoneService.sendMessage`, `PhoneService.sendReply`
and `RoomsMcpAgentTools.call` and verifies that the guard passes. Separate negative
cases change catalog wording, add a key and put inline text through System sinks;
they verify the owner-approval and catalog-key error messages.

```sh
NODE_OPTIONS=--max-old-space-size=4096 npm test -w @beeline/server -- --run src/system-message-catalog.test.ts --maxWorkers=2 --minWorkers=1
```
