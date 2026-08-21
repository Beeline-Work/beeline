# Beeline mobile client

Fork of **[Happy](https://github.com/slopus/happy)**'s Expo/React Native app
(`packages/happy-app`) as Beeline's client foundation (`spec.md` P1).

## Attribution / license

- Upstream: [slopus/happy](https://github.com/slopus/happy) — **MIT**
- Upstream commit: `2c8ecacc19f14abd81111a4605ac8c7f6bedb7e1`
  (`chore(app): August 7 changelog entry with Community Credits convention`)
- Upstream package: `packages/happy-app` (+ `packages/happy-wire` → `vendor/happy-wire`)
- Happy's MIT license is preserved in [`LICENSE`](./LICENSE)
- Also see [`UPSTREAM.md`](./UPSTREAM.md) for vendor provenance

The mobile app ships under one Beeline native identity and one production OTA channel.

## Monorepo integration (isolated install)

**Choice:** `apps/mobile` is **not** part of the root npm workspaces.

Happy is Expo 55 / RN 0.83 / React 19 with a large native graph. Root workspaces
hoist `apps/api` + `packages/*` (Node services). Mixing Expo into that graph
caused peer resolution fights; the simplest reliable setup is an **isolated**
`apps/mobile` install with its own `package-lock.json` and `.npmrc`
(`legacy-peer-deps=true`, matching Happy's pnpm-style peer looseness).

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

The mobile package version is the release source of truth. `npm run version:check`
prints it and rejects a build from a release-tagged commit unless the tag is exactly
`v<package version>`; Expo uses it for Android `versionName`.

### Signing

The release keystore is at [`android-signing/release.keystore`](./android-signing/README.md).
Credentials are committed alongside it because this repo is private. **Rotate the
keystore before any public distribution.**

## On-device Maestro smoke tests

The mobile harness uses [Maestro](https://maestro.mobile.dev/) against the existing
`emulator-5554` Android emulator. It is intentionally a separate CLI rather than a
JavaScript test dependency: Maestro drives the installed release APK through Android
accessibility/test IDs, so it exercises the actual device bridge and relay transport.

Install Maestro once if it is not already on `PATH`:

```sh
curl -Ls "https://get.maestro.mobile.dev" | bash
```

Then, from this directory, run:

```sh
npm run e2e
```

`e2e` keeps using `emulator-5554`; it does not create another emulator. The command
builds a production APK with an 8 GiB Gradle heap, provisions a fresh relay-backed
Workspace and Room with [`../../scripts/provision-smoke.ts`](../../scripts/provision-smoke.ts),
installs the APK, and passes the ephemeral identity/Room IDs to
[`e2e/smoke.yaml`](./e2e/smoke.yaml). The flow imports that identity, enters its
Workspace, opens the Room, verifies Android back returns to the list within one
second, then sends and observes a real relay message.

For a source-only flow iteration after a successful build, reuse the current APK:

```sh
MAESTRO_SKIP_BUILD=1 npm run e2e
```

The stable smoke flow deliberately does not cover the transitional Corner UI. The
planned contract is recorded in [`e2e/corner-session.todo.yaml`](./e2e/corner-session.todo.yaml):
use [`../../scripts/ui-demo-provision.ts`](../../scripts/ui-demo-provision.ts) to seed
the real corner/review fixture, then assert the redesigned feed, presence states, and
live-agent steer delivery once those selectors are settled.

## Expo web (headless-verifiable surface)

```sh
cd apps/mobile
npx expo start --web --port 8081
# open http://localhost:8081
```

Evidence of a successful boot is recorded in the PR (terminal transcript +
screenshot when available).

## Buzz transport seam

- Spec methods: repo root `spec.md` Appendix
- Cut-over map: [`BUZZ-SEAM.md`](./BUZZ-SEAM.md)
- TypeScript interface: `sources/sync/transport/rig-transport.ts`
- Happy scaffold adapter: `sources/sync/transport/happy-rig-transport.ts`
- Product flags: `sources/constants/buzzyFlags.ts`
  - `hideTerminalUI` — terminals stubbed (no live PTY)
  - `hideFriendsSocial` — Happy friends UI hidden

**Do not wire Buzz networking in this package until the adapter lane.**

## What was stripped / flagged

| Area | Action |
|---|---|
| Terminal connect UI | Flagged off (`BUZZY_FLAGS.hideTerminalUI`) |
| Friends social routes | Flagged off (`hideFriendsSocial`) |
| Tauri desktop (`src-tauri`) | Not vendored |
| Native `android/` / `ios/` prebuilds | Not vendored (Expo prebuild when needed) |

Happy account auth remains for the shell to boot; channel-scoped identity is
the adapter lane.

## Diffing against upstream

```sh
git clone https://github.com/slopus/happy /tmp/happy
cd /tmp/happy && git checkout 2c8ecacc19f14abd81111a4605ac8c7f6bedb7e1
diff -ru /tmp/happy/packages/happy-app sources  # adjust paths
# or compare apps/mobile to packages/happy-app at that commit
```
