# Beeline mobile client

Fork of **[Happy](https://github.com/slopus/happy)**'s Expo/React Native app
(`packages/happy-app`) as Beeline's client foundation (`spec.md` P1).

## Attribution / license

- Upstream: [slopus/happy](https://github.com/slopus/happy) — **MIT**
- Upstream commit: `2c8ecacc19f14abd81111a4605ac8c7f6bedb7e1`
  (`chore(app): August 7 changelog entry with Community Credits convention`)
- Upstream package: `packages/happy-app`
- Happy's MIT license is preserved in [`LICENSE`](./LICENSE)
- Also see [`UPSTREAM.md`](./UPSTREAM.md) for vendor provenance

The mobile app ships under one Beeline native identity with governed beta and
production OTA channels.

## OTA release governor

The one release button is
[`unified-release.yml`](../../.github/workflows/unified-release.yml); its app
leg is the composite action
[`mobile-ota-leg`](../../.github/actions/mobile-ota-leg/action.yml). It reads
the runtimes live in Google Play and App Store Connect, publishes this release
to its own EAS branch `release-<version>` with one update per live runtime,
points the `beta` channel at it, then points `production` at the same branch.
No emulator or device rehearsal runs in GitHub Actions unless the release
explicitly requests the device proof.

The published GitHub Release's `release.json` records the branch, its targets
and the branch before it. Manual recovery lives in the clearly named
[`mobile-ota-rollback.yml`](../../.github/workflows/mobile-ota-rollback.yml),
which points `production` back at the previous release's branch; its `branch`
input can name another one. See
[docs/release-pipeline.md](../../docs/release-pipeline.md#phone-ota-by-channel-pointer).
The runtime version is pinned by hand per platform in `app.config.js`
(`runtimeVersion` under the `ios` and `android` Expo config sections — see the
file for the current values). It has to be: an installed binary keeps the stamp it was built with, so
a stamp that recomputes itself per commit — the fingerprint policy v0.0.42
shipped — silently orphans every app already on a phone, which then reports
`NoUpdatesAvailable` forever. Bumping the pin says a new native build will
ship. Until a store release puts that build live, OTAs keep going to the
runtimes already live in the stores.

The compatibility check that a computed stamp did give is enforced at review
time instead, by the `NATIVE FINGERPRINT` gate
([`scripts/native-fingerprint.mjs`](scripts/native-fingerprint.mjs)): it
recomputes the Expo native fingerprint of both platforms
(`fingerprint.config.js` decides what counts) and fails when
[`native-fingerprint.json`](native-fingerprint.json) no longer describes the
tree, naming both platforms' old and new stamps. Run it locally with

```sh
cd apps/mobile && npm run fingerprint:check     # what CI runs
cd apps/mobile && npm run fingerprint:write     # after a deliberate pin bump
```

## Monorepo integration (isolated install)

**Choice:** `apps/mobile` is **not** part of the root npm workspaces.

The app is Expo 55 / RN 0.83 / React 19 with a large native graph. Root workspaces
hoist `apps/api` + `packages/*` (Node services). Mixing Expo into that graph
caused peer resolution fights; the simplest reliable setup is an **isolated**
`apps/mobile` install with its own `package-lock.json` and `.npmrc`
(`legacy-peer-deps=true`).

Root `package.json` still wires:

```sh
# from repo root
npm install                          # workspaces only (api, packages/*)
npm run mobile:install               # apps/mobile isolated install
npm run typecheck                    # turbo (api/nostr) + mobile tsc
npm run mobile:web                   # expo start --web
```

Or:

```sh
cd apps/mobile
npm install
npm run typecheck
npm run web          # expo start --web
npm start            # expo start (all platforms)
```

## Build a sideloadable release APK

### Prerequisites

- Android SDK at `/home/lunchbox/android-sdk` (set `ANDROID_HOME`)
- Build tools 35+, platform android-35+
- JDK 17+ (`java -version`)

### One-step build

```sh
cd apps/mobile
npm run apk:release
```

This runs the full chain:

1. `npx expo prebuild --platform android --clean` — generates the Beeline Android project
2. `scripts/patch-android-signing.sh` — applies release signing and permits operator-provided HTTP LAN relays
3. Gradle builds the signed release APK with its build cache enabled
4. `scripts/android-teardown.sh` stops the named emulator, adb server, and Gradle daemon
5. Prints the APK path and file size

Output: `android/app/build/outputs/apk/release/app-release.apk`

### Fast throwaway-worktree builds

`expo prebuild --clean` correctly removes the generated Android project, including
per-worktree `.cxx` output. React Native's supported CMake setup automatically
uses `ccache` when it is on `PATH`; the release wrapper sets a shared
`~/.cache/beeline-android-ccache` namespace and normalizes paths relative to the
repository, so unchanged NDK objects are reused safely across equivalent worktrees.
Install `ccache` on build hosts before the first build; without it the build remains
correct but native objects must be compiled again. Gradle's shared user-home cache
is independently enabled for cacheable Android tasks. Expo 55/React Native 0.83
currently starts Node processes during Gradle configuration, so configuration cache
is deliberately not enabled; Gradle reports those processes as incompatible.

The mobile package version is the release source of truth. It must use one to three
numeric components (for example, `0.2.18`): Expo uses it for Android `versionName`
and iOS `CFBundleShortVersionString`. `npm run version:check` runs before every
native release build and rejects a release-tagged commit unless the tag is exactly
`v<package version>`.

### Signing

The release keystore lives only in the `ANDROID_SIDELOAD_*` repository
secrets, not in the tree — see
[`android-signing/README.md`](./android-signing/README.md) for the secret
names, the 2026-10-15 key rotation, and how `apk:release` materializes and signs
with them. A signing-key rotation requires existing sideload installs to be
uninstalled and reinstalled.

iOS production builds use local EAS credentials (`credentialsSource: "local"`).
The distribution certificate and App Store provisioning profile were created through
the App Store Connect API, so they are intentionally absent from `eas credentials`.
Keep their absolute paths and password only in gitignored `credentials.json`; never
commit that file or its credential material.

## On-device Maestro smoke tests

The mobile harness uses [Maestro](https://maestro.mobile.dev/) against the existing
`emulator-5554` Android emulator. It is intentionally a separate CLI rather than a
JavaScript test dependency: Maestro drives the installed release APK through Android
accessibility/test IDs, so it exercises the actual device bridge, monolith writes,
and server-indexed reads.

Install Maestro once if it is not already on `PATH`:

```sh
curl -Ls "https://get.maestro.mobile.dev" | bash
```

Then, from this directory, run:

```sh
npm run e2e
```

`e2e` uses the selected Android device and verifies its running update before
opening the app. Set `BEELINE_REVIEW_SECRET` for an existing review identity;
`scripts/maestro-room.mjs` reads its Workspace and Room through the authenticated
monolith API. The flow signs in through the existing review link and opens that
Room's transcript. It creates no fixture accounts, Rooms or messages.

For a source-only flow iteration after a successful build, reuse the current APK:

```sh
MAESTRO_SKIP_BUILD=1 npm run e2e
```

## Expo web (headless-verifiable surface)

```sh
cd apps/mobile
npx expo start --web --port 8081
# open http://localhost:8081
```

Evidence of a successful boot is recorded in the PR (terminal transcript +
screenshot when available).

## Desktop (Tauri)

The desktop app is that same web bundle in a native window. The crate, the
three build configurations and the generated icons live in `src-tauri/`; see
[src-tauri/README.md](src-tauri/README.md) for what each variant is for.

```sh
cd apps/mobile
npm run tauri:dev                # Beeline Dev against the Expo dev server
npm run tauri:build:preview      # installable Beeline Preview bundle
npm run tauri:build:production   # release identity
```

Installers for all three platforms are built by the `Desktop` workflow and
downloadable from its run.

## Mobile transport

`sources/sync/transport/buzz-rig-transport.ts` is the mobile write seam and is
monolith-only: `BuzzRigTransport` is the stable public name for
`MonolithRigTransport`. Room and Workspace reads use `RoomViewClient` against
the effective server endpoint; the retained `@beeline/buzz-client` HTTP bridge
is not a mobile write fallback. The inherited server runtime, account context,
session UI, client-side encryption, voice service, and terminal pairing flows
have been removed. Native `android/` and `ios/` projects remain generated by
Expo prebuild when needed.

## Diffing against upstream

```sh
git clone https://github.com/slopus/happy /tmp/happy
cd /tmp/happy && git checkout 2c8ecacc19f14abd81111a4605ac8c7f6bedb7e1
diff -ru /tmp/happy/packages/happy-app sources  # adjust paths
# or compare apps/mobile to packages/happy-app at that commit
```
