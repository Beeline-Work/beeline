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
- Do not wire Buzz networking until the adapter lane; keep Happy backend compiling.
