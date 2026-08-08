# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Gate / live security tests

- Product authority: `spec.md` (esp. **Failure modes → Agent in push-rights**).
- Merge-gate library + worker: `apps/gate/` (see `apps/gate/README.md`).
- Live suite (real Buzz relay): `cd apps/gate && npm run test:live` after `npm run stack:up` at repo root. Soft-skips only when the relay is unreachable.
- Provisioning check (agent never in push-allowed): `apps/gate/src/provisioning.ts` (library + CLI via `npm run provisioning -w @buzzy/gate`).
- One-shot end-to-end proof remains `npm run prove` (`scripts/money-shot.ts`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Mobile client (Happy fork)

- `apps/mobile` is a **vendored Happy** Expo app, **isolated** from root npm workspaces.
- Install: `npm run mobile:install` (or `cd apps/mobile && npm install`).
- Typecheck: root `npm run typecheck` runs turbo + mobile tsc.
- Web: `npm run mobile:web` / `cd apps/mobile && npx expo start --web`.
- Buzz seam docs: `apps/mobile/BUZZ-SEAM.md`; interface: `sources/sync/transport/rig-transport.ts`.
- **BuzzRigTransport** (`sources/sync/transport/buzz-rig-transport.ts`): P1 implementation against `@buzzy/buzz-client`. Covers: identity, sessionsRead, sessionRead, sessionEventsBackfill, sessionEventsSubscribe, messageSubmit. Everything else stubbed (RigTransportNotImplementedError).
- **Dependency strategy**: `@buzzy/buzz-client` and `@buzzy/nostr` are resolved via Metro `resolveRequest` aliases to their `dist/` in `../../packages/`. Transitive deps (`@noble/*`, `nostr-tools`) resolve via Metro's node_modules walk-up into the root workspace. See `metro.config.js` for the alias list.
- **Buzz UI screens** (`sources/app/(app)/buzz/`): parallel minimal path using BuzzRigTransport directly (no Happy sync layer). Onboarding, channel list, and chat screens.
- Typecheck: the mobile app's `tsc --noEmit` produces hundreds of pre-existing 'cannot find module' errors for `react-native`, `expo-*`, etc. due to module resolution. These are NOT caused by new code. Metro bundles successfully despite these tsc errors.
- **Tradeoff**: the parallel screen path avoids deep refactoring of Happy's sync layer. The next lane (P2) should decide whether to unify screens or continue the parallel path.
