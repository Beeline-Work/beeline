# Android cancellation without Event

Reproduction **ANDROID-EVENT-ABORT-1** uses LiveKit 2.22.4's distributed
`SignalClient.join`, a pending disposable WebSocket, and the real native
`AbortController`. No production account, network service, or microphone is used.
This isolates the connection-cancellation part of leaving Conversation mode.

On Android API 35, React Native 0.83.1, Hermes, with the native global `Event`
absent naturally:

- Before: `ReferenceError: Property 'Event' doesn't exist` ([screenshot](failing.png)).
- After: `PASS: Hermes, Event=undefined, cancelled=3, Abort handler called`
  ([screenshot](passing.png)).

The same installed debug APK and fixture were used before and after replacing
the SDK JavaScript. [Device results](device-results.txt) preserve both outcomes.
The fixture captures the real async listener rejection so the failure is visible
on screen rather than leaving an unhandled rejection and a pending join.

## Cause and fix

LiveKit `src/api/SignalClient.ts:455` evaluates `eventOrError instanceof Event`
inside its async `abortHandler`. The fix reads the event's `currentTarget`
structurally. Its reason formatter (`src/api/utils.ts:63`) also assumes
`AbortSignal.reason` exists. React Native's `abort-controller` has no such
property; without the second fix, cancellation next throws on `'toString' in
undefined`. Missing reasons now use the existing default message.

`scripts/patch-livekit-abort.cjs` patches the source and both distributed SDK
entrypoints during installation, checks the exact installed version and expected
code, and is idempotent. It makes no global Event shim. A dependency upgrade must
reassess this patch. The script avoids committing the entire minified UMD line.

Beeline's teardown is `sources/buzz/use-voice-call.ts:29`,
`closeVoiceTransport` → `room.disconnect()`. During a pending connection,
LiveKit `src/room/Room.ts:1178` aborts its controller. Beeline also calls
`room.connect` at lines 236 and 253; LiveKit's replacement-connection path
aborts an earlier controller at `Room.ts:898`.

## Historical stack attribution limitation

Checked out release `6d908054c0dd404885ec2daa08115c9ef5ed10c2` in a detached
worktree, built its shared packages, and exported Android with Expo's production
Hermes exporter and `--source-maps --max-workers 2`. The mobile lockfile is
unchanged between that release and the fix's base. Two reconstruction attempts
used shared installed dependencies and then release-local shared-package links
and an unpatched local LiveKit copy. A diagnostic non-bytecode export was also
produced. Neither reconstruction matches the original columns exactly.

For the second Hermes reconstruction, reverse source-map lookups identify these
equivalent functions (generated columns below are zero-based, line 1):

| Function | Rebuilt column | Compiled LiveKit source |
| --- | ---: | --- |
| `fulfilled` helper | 4850100 | `livekit-client.esm.mjs:8755` |
| async `abortHandler` | 5009272 | `livekit-client.esm.mjs:18781` |
| unsafe Event check | 5010803 | `livekit-client.esm.mjs:18786` |
| replacement connection abort | 5194831 | `livekit-client.esm.mjs:34103` |
| disconnect abort | 5197965 | `livekit-client.esm.mjs:34304` |

The reported columns 4828886, 5177510, 446992, 446464, 451515, 4989756, and
4989823 do **not** directly map to the named functions in this reconstruction.
Do not apply a guessed constant offset or claim exact historical symbolication.
The SDK source, reproduced async listener stack, and native before/after result
identify the defect, but the original anonymous abort caller cannot be uniquely
distinguished between the connection replacement and disconnect paths from this
rebuilt map. Exact AC-1 historical frame attribution still needs the original
release bundle/map or an exactly matching build environment. Source-map uploads
are intentionally left to the sibling corner.

## Repeat

From `apps/mobile`, run `npx vitest run sources/buzz/livekit-abort.test.ts
--maxWorkers 1`. Six cases cover cancellation, timeout classification, and
missing reasons in both ESM and CommonJS distributions. Removing the Event fix
fails with ReferenceError; removing the reason fix fails on the native-shaped
signal. Applying the install patch twice to pristine SDK files also passes.

For native proof, build a debug Android APK with Expo prebuild and Gradle
`assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=2`. Temporarily
select `scripts/livekit-abort-native-proof.tsx` as package `main`, serve it with
Expo on port 18081, reverse that port with adb, and open the development-client
URL. Restore `main` to `index.ts` afterward. The fixture refuses a non-Hermes
runtime or a runtime that has a global Event. For the baseline, restore pristine
LiveKit source and distribution files, then reload; reapply the installation
patch and reload for the passing result. Never ship the fixture as the app entry.

## Validation limits

Root `npm run typecheck` passes, as do all six regression cases after applying
the install patch twice to pristine SDK files. The native debug APK builds.
`npm run fingerprint:check --prefix apps/mobile` fails against the committed
baseline on both platforms. A separate untouched checkout of the same base
(`2f40d2e6c`), using the installed dependencies, also fails that check. Its
computed hashes differ from this checkout, so this does not establish the full
cause of the fingerprint drift. No runtime pins or fingerprint records were
changed to conceal the failure. CI must establish the clean-install result.
