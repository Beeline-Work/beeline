# Buzzy mobile client

Fork of **[Happy](https://github.com/slopus/happy)**'s Expo/React Native app
(`packages/happy-app`) as Buzzy's client foundation (`spec.md` P1).

## Attribution / license

- Upstream: [slopus/happy](https://github.com/slopus/happy) — **MIT**
- Upstream commit: `2c8ecacc19f14abd81111a4605ac8c7f6bedb7e1`
  (`chore(app): August 7 changelog entry with Community Credits convention`)
- Upstream package: `packages/happy-app` (+ `packages/happy-wire` → `vendor/happy-wire`)
- Happy's MIT license is preserved in [`LICENSE`](./LICENSE)
- Also see [`UPSTREAM.md`](./UPSTREAM.md) for vendor provenance

Buzzy rebrands the app name/scheme minimally ("Buzzy"); visual polish is
intentionally deferred.

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
