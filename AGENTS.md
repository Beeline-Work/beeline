# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Gate / live security tests

- Product authority: `spec.md` (esp. **Failure modes → Agent in push-rights**).
- Merge-gate library + worker: `apps/gate/` (see `apps/gate/README.md`).
- Live suite (real Buzz relay): `cd apps/gate && npm run test:live` after `npm run stack:up` at repo root. Soft-skips only when the relay is unreachable.
- Provisioning check (agent never in push-allowed): `apps/gate/src/provisioning.ts` (library + CLI via `npm run provisioning -w @beeline/gate`).
- Agent-approval invariant: the worker checks the self-signed `#t=buzz-agent` identity registry before roles; `apps/gate/src/agent-identity.live.test.ts` proves an agent configured as admin/trusted reviewer is refused while a human admin on the same tip is accepted.
- One-shot end-to-end proof remains `npm run prove` (`scripts/money-shot.ts`).

## Body (@beeline/body) — agent session manager

- `apps/body/` — agent body service (see `apps/body/README.md`).
- **Read-only boundary = mount boundary**: TLC sessions get `mcpServers: []` (no write tools); edit sessions get `buzz-dev-mcp` for shell/str_replace. Enforced at ACP `session/new`, not via prompt.
- Body drives `buzz-agent` directly over stdio (NOT `buzz-acp`), because `buzz-acp` auto-approves permissions and doesn't expose `session/update` to the relay.
- Activity projection: body bridges ACP `session/update` → kind:9 `#t=agent-activity` channel events for multi-user visibility.
- Body operator and agent keys are always distinct; the agent key signs activity, control messages, and new subchannels. Community-linked provisioning publishes the first-class record defined in `packages/buzz-client/src/agent.ts`.
- Subchannel = child channel (kind:9007, UUID) + mirrored members + git worktree + edit-mode ACP session.
- buzz-agent ACP wire vs MCP: `initialize` uses `protocolVersion` u32 (not MCP string), `clientCapabilities` (not `capabilities`). `session/new` returns `{sessionId}`. Standard MCP for `buzz-dev-mcp`. See `apps/body/src/acp.ts` for exact wire format.
- Live suite: `cd apps/body && npm run test:live` (pretest builds all deps). Soft-skips when relay or LLM env (BUZZY_LLM_*) absent.
- Agent pairing and server-held soul generation are exposed by `apps/body/src/cli.ts` as `buzz pair` and `buzz serve-souls`; credential/config details live in `apps/body/README.md`.
- Channel → branch loop: `buzz serve <channel> <owner> <repo>` watches only human `t=buzz-agent-request` messages addressed to its agent key, opens an agent-signed subchannel, pushes merge-ready tips, and archives only after `main` reaches the approved tip. Live proof: `apps/body/src/channel-branch-loop.live.test.ts`.

## Release APK build (@beeline/mobile)

- `npm run apk:release` in `apps/mobile` builds a signed release APK (expo prebuild → patch signing config → gradle assembleRelease).
- Release keystore: `apps/mobile/android-signing/release.keystore` (stored pass in sibling README, rotate before public distribution).
- Configurable relay URL: persisted per-device via `buzz-identity-storage.ts`, default `https://buzz.trustysquire.ai`.
- Onboarding/channels screens have a relay URL text field (editable).
- Gradle signing config is injected by `scripts/patch-android-signing.sh` after prebuild because the `android/` directory is gitignored.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## GrokNight alien-hull UI theme

- **Design tokens**: `apps/mobile/sources/buzz/groknight.ts` — single source of truth for all GrokNight palette hexes (bg, text, accent, border colors). Every buzzy screen imports from here; no hardcoded hexes.
- **Design authority**: GrokNight alien-hull system. Near-black flat surfaces, brushed chrome/steel neutrals, monospace typography, and one cyan `#7dcfff` accent reserved for primary actions, active/focus/live state, and the merge-approval gate.
- **Restyled screens**: `buzz/channels.tsx`, `buzz/chat/[channelId].tsx`, `buzz/onboarding.tsx` — session/channel list, live session transcript with merge controls and composer, and key onboarding.

## Mobile client (Happy fork)

- `apps/mobile` is a **vendored Happy** Expo app, **isolated** from root npm workspaces.
- Install: `npm run mobile:install` (or `cd apps/mobile && npm install`).
- EAS installs this isolated app without a root `node_modules`; keep optional monorepo paths in `metro.config.js` existence-guarded, and build file-linked `@beeline/*` packages through `eas-build-post-install`. Regression coverage: `sources/config/*Config.test.ts`.
- Typecheck: root `npm run typecheck` runs turbo + mobile tsc.
- Web: `npm run mobile:web` / `cd apps/mobile && npx expo start --web`.
- Buzz seam docs: `apps/mobile/BUZZ-SEAM.md`; interface: `sources/sync/transport/rig-transport.ts`.
- **BuzzRigTransport** (`sources/sync/transport/buzz-rig-transport.ts`): P1 implementation against `@beeline/buzz-client`. Covers: identity, sessionsRead, sessionRead, sessionEventsBackfill, sessionEventsSubscribe, messageSubmit. Everything else stubbed (RigTransportNotImplementedError).
- **Dependency strategy**: `@beeline/buzz-client` and `@beeline/nostr` are resolved via Metro `resolveRequest` aliases to their `dist/` in `../../packages/`. Transitive deps (`@noble/*`, `nostr-tools`) resolve via Metro's node_modules walk-up into the root workspace. See `metro.config.js` for the alias list.
- **Buzz UI screens** (`sources/app/(app)/buzz/`): parallel minimal path using BuzzRigTransport directly (no Happy sync layer). Onboarding, channel list, and chat screens.
- **Community shell**: `sources/components/buzz/CommunityRail.tsx` wraps Buzz screens; `buzz/channels.tsx` scopes channels to the selected community, and `join/[token].tsx` owns signed `buzzrouter.com/join/<token>` preview, inline identity creation, and redemption. Selection persistence lives in `sources/buzz/community-storage.ts`.
- **Agent profiles**: `buzz/agents.tsx` pairs desktop/headless agent identities and joins them with human-signed, community-scoped display overlays from `packages/buzz-client/src/agent.ts`. Soul overlays carry no authority and never participate in gate enforcement.
- Typecheck: `tsc --noEmit` has one pre-existing error in `buzz-rig-transport.ts` (unrelated to UI). Metro bundles successfully.
- **P2 merge UI** (`apps/mobile/sources/app/(app)/buzz/chat/[channelId].tsx`): approve button in subchannels reads merge target from body-control messages (repo,branch,tip tags), signs P0-gate-shape approval via `submitMergeApproval`, shows async states. Merge-summary messages (t=merge-summary) render with green border. Archived subchannels (status=archived) disable text input. Provenance shows short npub next to each message.
- **Workspace/Room navigation** (`apps/mobile/sources/app/(app)/buzz/channels.tsx`): top-level navigation shows Rooms only. Agent subchannels are presented as changes inside their parent Room's live review surface, with change counts on the Room list.
- **Body control message shape**: subchannel-open and intro messages now carry `["repo", ownerHex/repo]`, `["tip", 40-hex]` tags alongside existing `branch`, `subchannel`, `session`, `mode` tags. See `apps/body/src/body.ts` `openSubchannel()`.
- **`getSubchannelMergeTarget()`**: reads merge target from subchannel body-control messages in `BuzzRigTransport`. Used by the Approve button UI.
- **Merge approval wire**: `buildMergeApproval`/`submitMergeApproval` from `@beeline/buzz-client` produce kind:9 events with `t=buzz-merge-approval`, `repo`, `branch`, `tip` tags. Gate worker (`apps/gate/src/worker.ts`) verifies the exact binding. No workflow kinds (46010/46011/46012).
- **Demo script**: `scripts/merge-demo.ts` exercises the full merge flow end-to-end against live relay.
- **Tradeoff**: the parallel screen path avoids deep refactoring of Happy's sync layer. If extending screens further, consider unifying with Happy's screen hierarchy.

## Android push notifications

- App registration lives in `apps/mobile/sources/push/buzz-push-registration.ts`; runtime defaults/overrides are in `app.config.js` and `sources/buzz/runtime-config.ts`. The public gateway default is `https://push.buzzrouter.com`.
- Gateway authority and operations: `apps/push-gateway/README.md`. It binds `127.0.0.1:8788` by default, persists registrations under its ignored `.data/`, and requires a service-account path via environment variable; credentials and device tokens must never be logged or committed.
- Gateway checks: `npm run build -w @beeline/push-gateway && npm test -w @beeline/push-gateway`.

## Community model

- SDK authority: `packages/buzz-client/src/community.ts`; gate convention + live proof: `apps/gate/src/community.live.test.ts`.
- A community reuses NIP-29 group state: kind:9007 stream create with a self-referencing `community=<h UUID>` tag, kind:9000 roles, and 39001/39002 admin/member projections. Contained channels carry `community=<community UUID>`; absent remains a valid standalone channel.
- Invites are signed community-scoped kind:9 events (`t=buzz-community-invite`, `d=SHA-256(token)`, NIP-40 `expiration`). Redemption validates the marker and self-adds through kind:9000; plaintext tokens are never published.
