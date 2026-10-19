# Native proof theme startup

Reproduction `PROOF-THEME-1` covers the disposable `Call` screens in
`multi-human-silence-native-proof.tsx` and `voice-delivery-native-proof.tsx`.
The Sentry 7799259998 receipt has no crashing-bundle identity or source maps;
this evidence does **not** establish that a shipped screen crashed.

Both entries imported `setAppAppearance` and also imported the same module for
its side effects. Expo merges those imports. Metro's enabled inline-require pass
then moves the only theme-module evaluation into the appearance button callbacks.
Rendering `Call` first evaluates a themed component with no selected theme.
An explicit startup `require` survives that transform, while preserving the
existing appearance buttons. The production entry and Sentry configuration are
unchanged.

## Regression

Before the entry changes, both cases in
`../../sources/native-proof-theme-bootstrap.test.ts` failed with
`Call stylesheet evaluated before the initial theme was selected` (see
[baseline output](baseline-test.txt)). The test runs the actual Expo Babel preset
and Metro inline-require plugin, invokes the transformed entry's root and `Call`,
and evaluates the transformed production `VoiceCallCard` stylesheet. Native
modules, hooks and theme selection are test substitutes. It also requires
initialization to have completed before root registration.

After the fix, both cases pass. The six existing appearance tests and four Sentry
tests pass, and root `npm run typecheck` passes.

```sh
cd apps/mobile
npx vitest run sources/native-proof-theme-bootstrap.test.ts sources/unistyles.test.ts sources/buzz/sentry.test.ts --maxWorkers=2
```

## Android method

The device proof uses a Beeline-leased, isolated API 36 x86_64 emulator and
locally built release/Hermes APKs with generated debug signing. In generated,
ignored Android files only, disable Expo Updates and allow loopback cleartext.
Set `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:18097`, build with two Gradle
workers and a 4 GiB heap, and grant microphone permission.

Run the existing `scripts/prove-multi-human-silence.ts` fixture with
`SILENCE_PROOF_ANDROID_FIRST=1 SILENCE_PROOF_HOLD=1`. It uses disposable PGlite
and a local LiveKit server (signalling 17890, TCP 17891, UDP 17892–17910;
development-only `devkey`/`secret`). STT/brain/TTS are controlled substitutes.
No production server or identity is used.

For the silence entry, use this generated `apps/mobile/android/theme-proof-entry.js`
authentication bootstrap as Gradle's entry file. It does not import or configure
the theme; the tested entry must initialize it itself:

```js
require('react-native-get-random-values');
const { monolithSession } = require('../sources/auth/monolith-session');
monolithSession.fetch = (input, init = {}, options = {}) =>
  (options.fetchImpl || fetch)(input, init);
require('../scripts/multi-human-silence-native-proof');
```

The delivery entry already contains the same disposable authentication override;
use it directly as Gradle's entry file. For each APK: force-stop, cold launch,
observe `Call`, press Join, background with Home, then reopen. Save the cold,
joined and resumed screenshots, server observations, unchanged process/call IDs,
and the scan for native fatal or missing-theme errors. The call timer prevents
UIAutomator from reaching idle; screenshots and the fixture's mounted-hook
observations establish the rendered path.

The disposable fixture copy also treats a single NUL request body as empty,
matching the production Android request-body parser. This is necessary for its
Join endpoint and is not a repository server change. The original Sentry bundle
was unavailable; the failing transform regression is the before-fix stand-in.

## Results

Both entries passed cold launch, Join, Home and reopen on API 36. Each resumed
screen visibly says `Joined · humans 2`; each retained its original process ID
and call ID. Neither run recorded a missing-theme error or native fatal exception.

| Entry | Cold render | Resumed call | Observations |
| --- | --- | --- | --- |
| Silence | [Screenshot](silence-cold.png) | [Screenshot](silence-resumed.png) | [Result](silence-result.json) |
| Delivery | [Screenshot](delivery-cold.png) | [Screenshot](delivery-resumed.png) | [Result](delivery-result.json) |

[Build provenance](build.json) records the APK and source hashes. This establishes
the two proof-entry startup and resume paths, not notification/headless startup
of a shipped app or the identity of the original Sentry bundle.

## Shipped-path control

The separate [shipped-entry audit](../shipped-theme-audit/README.md) tested a release
build from `index.ts`, including cold notification tap, a committed headless
reply, and joined-call resume, with Sentry initialization enabled. It did not
reproduce the missing-theme error. That audit is retained as the Reproduction
record and does not identify the original crashing bundle.

After restoring this fix, the transform regression was repeated against both
unfixed entries and failed in each case, then passed against the restored
entries. The restored script and regression hashes match the recorded native
device proof in `build.json`; no device proof is attributed to changed sources.
