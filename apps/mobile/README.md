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

The mobile app ships under one Beeline native identity with governed beta and
production OTA channels.

## OTA release governor

`main` is a candidate source, not a release trigger. The
[`mobile-ota.yml`](../../.github/workflows/mobile-ota.yml) workflow publishes an
immutable update group to the `beta` branch, installs the latest `beta-apk` on
the host's existing Android emulator, runs the real Room open/send/reply Maestro
smoke, then republishes that exact group to `production`. It never rebuilds the
JavaScript or assets during promotion.

The first beta binary for a runtime (and every later native/runtimeVersion
change) must be built once before an OTA candidate can pass the canary:

```sh
cd apps/mobile
npx --yes eas-cli@22.2.0 build --profile beta-apk --platform android --non-interactive
```

A beta-channel binary is the only possible canary vehicle: the OTA update
channel is baked into the APK at build time (`EXPO_UPDATES_CHANNEL`), so a
production-channel binary for the same runtimeVersion cannot fetch the beta
candidate group. Until that build exists, the governor parks promotion with
that exact remediation recorded in the release ledger (`canary.status:
"blocked"` plus `reason`), and never records a broken canary as success.

The canary is locally runnable and self-limits to nine minutes. It reuses the
named AVD and either downloads the latest successful `beta-apk` or installs an
operator-supplied APK:

```sh
cd apps/mobile
EXPO_TOKEN=... scripts/ota-canary.sh --ledger /path/to/mobile-ota-ledger.json
# or: BEELINE_BETA_APK=/path/to/beta.apk scripts/ota-canary.sh --ledger ...
```

Every successful release stores `candidateGroupId`, the republished production
group, and `previousProductionGroupId` in the `mobile-ota-ledger-<run-id>`
workflow artifact. Choose `rollback` in the workflow dispatch UI to republish
that recorded predecessor; `rollback_group` can override it with another known
good group. The captain-only emergency path is a manual `release` dispatch with
`skip_canary=true`; it defaults to false and is recorded in the ledger.

The direct rollback one-liner is:

```sh
cd apps/mobile && npx --yes eas-cli@22.2.0 update:republish --group <LAST_GOOD_GROUP_ID> --destination-branch production --platform all --message "captain rollback" --json --non-interactive
```

`--destination-branch production` is intentional: with `--group`, current EAS
CLI uses `--branch` to select a source rather than to name the destination.
Native changes still require a binary rebuild and runtimeVersion bump; the
governor does not relax that compatibility boundary.

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

The mobile package version is the release source of truth. It must use one to three
numeric components (for example, `0.2.18`): Expo uses it for Android `versionName`
and iOS `CFBundleShortVersionString`. `npm run version:check` runs before every
native release build and rejects a release-tagged commit unless the tag is exactly
`v<package version>`.

### Signing

The release keystore is at [`android-signing/release.keystore`](./android-signing/README.md).
Credentials are committed alongside it because this repo is private. **Rotate the
keystore before any public distribution.**

iOS production builds use local EAS credentials (`credentialsSource: "local"`).
The distribution certificate and App Store provisioning profile were created through
the App Store Connect API, so they are intentionally absent from `eas credentials`.
Keep their absolute paths and password only in gitignored `credentials.json`; never
commit that file or its credential material.

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
