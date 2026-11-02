# Android OTA integrity — Reproduction W-1

## Reproduced

Sentry [BEELINE-MOBILE-W](https://beeline-bt.sentry.io/issues/7824913490/)
reported a Hermes bundle declaring 13,002,596 bytes with only 5,390,336 cached.

On the local API 35 x86_64 emulator, install the runtime44/versionCode144
store artifact from release run `41387088503` (AAB SHA-256
`e98b2f8dc6d8d00f1c1e12c12fb42262144c7cbe5bbb6a316cca9061f7bf4606`).
Bundletool converted the AAB to a universal APK with local debug signing;
the native code and embedded bundle came from the store artifact. No account
was signed in.

Start once to download the production update. Force-stop, retain only the
first 5,390,336 bytes of its `.expo-internal` launch bundle, then start again.
Hermes attempted to load the partial file and reported the same failure class:
the current production bundle required 13,057,588 bytes. See
[W-1-before.txt](W-1-before.txt). The app did not reach JavaScript's
`Running "main"` after that cold start.

## Cause and fix

`useUpdates.ts` delegates check, fetch and reload to Expo. `update-receipt.ts`
reports the running update; neither writes cached files or marks updates READY.
PR #3347 restored delivery to runtime44; it did not implement another downloader.

Expo's Android downloader verifies SHA-256 before publication. However,
`UpdatesUtils.verifySHA256AndWriteToFile` then copied its verified temporary
file to the destination. That final copy was not atomic. An interruption there
could leave a partial destination. `Loader` reused existing filenames, including
on resumed PENDING downloads, and `DatabaseLauncher` checked existence rather
than integrity. These were the paths that bypassed verification. The original
device's interruption timing is not available; truncating its cached-file path
reproduces the resulting failure without assuming that timing.

The Android-only Expo patch:

- Checks the manifest/recorded SHA-256 before selecting a cached launch bundle.
- Marks updates sharing an invalid asset PENDING, removes that file and selects
  the last good update or embedded bundle without recording a failed JS launch.
- Revalidates READY and PENDING caches during fetch so a later check downloads
  missing bytes instead of promoting an existing partial file.
- Publishes verified temporary files with a same-directory rename.

Patch installation fails closed. Android moves to runtime45 because startup
validation runs before JavaScript; an OTA on runtime44 cannot install this fix.
There is no iOS patch or iOS runtime change. A new Android store binary is still
required; this work does not publish one.

## Demonstrated

Reproduction W-1 passes in the built Android app. Build the patched tree as
an x86_64 release APK, retain runtime44 in the generated proof project's native
configuration, and set the proof-only embedded manifest timestamp to
`1793592970230` (one millisecond newer than the store embedded bundle). This
keeps the actual production update newer than the proof's embedded bundle.
These overrides affect only ignored/generated proof files; committed Android
configuration is runtime45. Release shrinking was disabled for the proof build.

Restore the original update database and the same truncated cached file into
that installation, enable airplane mode, then cold-start. The app rejects the
partial cached bundle before Hermes sees it and reaches the sign-in screen on
its embedded bundle. The invalid update remains PENDING with no failed-launch
count, and the partial file is removed. See [W-1-after.txt](W-1-after.txt) and
the [offline screen](W-1-after.png).

Reconnect and cold-start again. The production update downloads completely,
becomes READY and reloads. Its cached file is now 13,057,588 bytes and its
SHA-256 matches the manifest. Another cold start in airplane mode reaches the
sign-in screen on that repaired cache without a Hermes startup error. See
[W-1-retry.txt](W-1-retry.txt) and the [repaired-cache screen](W-1-retry.png).

An initial debug-variant proof attempt hit an unrelated Expo dev-launcher
class-cast failure. The passing proof uses the release variant, with the real
Expo database, downloader, launcher and Hermes runtime. No stand-in is needed
for the visible startup/retry result; fixtures below provide the repeatable
regression checks.

## Regression proof

Run `node --test scripts/android-ota-integrity.test.mjs` from the repository root.
It compiles the installed Expo Android `DatabaseLauncher`, `Launcher`, `Loader`
and `UpdatesUtils` sources using a pinned Kotlin compiler. Android services,
DAO transport and network transport use the bounded fixtures beside `Proof.kt`;
selection, loading, validation and file publication execute production code.
A real Hermes compiler produces the complete bundle; the failing cache retains
exactly the Sentry-reported byte count.

Both story regressions fail against unpatched `expo-updates@55.0.26` and pass
against the patched dependency. See [W-1-regressions.txt](W-1-regressions.txt).

- `W-1: truncated cached bundle starts the last good or embedded update`
  checks both fallback choices, retryable state and repeated starts without
  deleting the good cache.
- `W-1: interrupted retry stays safe and the later full download launches`
  checks another failed transfer, the later complete download and launch, and
  pre-existing corrupt READY/PENDING caches encountered directly during fetch.

The same tests run in MOBILE SUITE. Other validation includes root typecheck,
workflow path validation, app branding and Android shrinking tests. Native
fingerprint verification accompanies the Android runtime bump.
