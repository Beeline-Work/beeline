# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Gate / live security tests

- Product authority: `spec.md` (esp. **Failure modes → Agent in push-rights**).
- Merge-gate library + worker: `apps/gate/` (see `apps/gate/README.md`).
- Live suite (real Buzz relay): `cd apps/gate && npm run test:live` after `npm run stack:up` at repo root. Soft-skips only when the relay is unreachable.
- Shipped relay defaults live in `packages/buzz-client/src/relay-config.ts` and point to `relay.buzzrouter.com`; Gate and Body consume them. Live Vitest configs explicitly pin the local relay stack.
- Provisioning check (agent never in push-allowed): `apps/gate/src/provisioning.ts` (library + CLI via `npm run provisioning -w @beeline/gate`).
- Agent-approval invariant: the worker checks the self-signed `#t=buzz-agent` identity registry before roles; `apps/gate/src/agent-identity.live.test.ts` proves an agent configured as admin/trusted reviewer is refused while a human admin on the same tip is accepted.
- One-shot end-to-end proof remains `npm run prove` (`scripts/money-shot.ts`).

## Body (@beeline/body) — agent session manager

- `apps/body/` — agent body service (see `apps/body/README.md`).
- **Read-only boundary = ACP mode + MCP capability boundary**: Room sessions request a supported read-only ACP mode and mount only Beeline's `buzz-readonly-mcp` (`apps/body/src/read-only-mcp.ts`), whose fixed repository-contained list/read/literal-search/local-history tools expose no shell, raw git args, or mutation. Pure information requests are locked to read-only Room answers and cannot project ALLOW even if the agent asks for a mutating permission. An explicit human open-a-corner command creates the isolated edit corner directly; for non-research work, the first actual mutating ACP request requires a current human member to sign ALLOW. DENY stays read-only. Edit sessions alone mount `buzz-dev-mcp`. Authority: `apps/body/src/body.ts` (`isReadOnlyInformationRequest`, `isChannelWorkIntent`, `replyInRoom`).
- Body drives `buzz-agent` directly over stdio (NOT `buzz-acp`), because `buzz-acp` auto-approves permissions and doesn't expose `session/update` to the relay.
- Activity projection: body bridges ordered ACP `session/update` batches → kind:9 `#t=agent-activity` channel events for multi-user visibility without exhausting per-key relay quotas. Read-only Room turns also publish `#t=agent-turn` working/complete lifecycle events for the mobile thinking indicator; `apps/body/src/activity.ts` owns that wire and the narrow Codex startup-warning filter.
- Body operator and agent keys are always distinct; the agent key signs activity, control messages, and new subchannels. Community-linked provisioning publishes the first-class record defined in `packages/buzz-client/src/agent.ts`.
- Chat files are link-only kind:9 references defined in `packages/buzz-client/src/attachment.ts`. Mobile and Body upload through `media.ts`; Body projects inbound URL metadata to ACP and turns agent output files/ACP images into the same tags in `apps/body/src/attachments.ts`, stripping binary fields from relay activity.
- Daemon HTTP relay access is authenticated by construction: `apps/gate/src/relay.ts` binds NIP-98 to an identity, delegates writes to the transient-retrying `packages/buzz-client/src/http.ts` publisher, `Body` reuses one agent-bound reader for Room reads, and `ChannelOpsContext` requires authenticated HTTP options. Retries resend the same signed event id, which the relay deduplicates. The auth-required two-party proof is `apps/body/src/daemon-relay-auth.live.test.ts`.
- Subchannel = child channel (kind:9007, UUID) + mirrored members + git worktree + edit-mode ACP session.
- Archive scope is child-only: `apps/body/src/body.ts` verifies the corner's immutable kind:9007 parent link, and `apps/gate/src/buzz.ts` independently refuses kind:9002 unless that link exists. `BuzzRigTransport.isChannelArchived` ignores parent Room status cards scoped with `subchannel=<corner>`. Top-level Workspace/Room lifecycle comes only from explicit metadata.
- buzz-agent ACP wire vs MCP: `initialize` uses `protocolVersion` u32 (not MCP string), `clientCapabilities` (not `capabilities`). `session/new` returns `{sessionId}`. Standard MCP for `buzz-dev-mcp`. See `apps/body/src/acp.ts` for exact wire format.
- Live suite: `cd apps/body && npm run test:live` (pretest builds all deps). The pair-runtime proof can use the sole auto-detected external ACP agent; reference-agent cases soft-skip when relay or LLM env (`BUZZY_LLM_*`) is absent.
- Supported runtime path: run `curl -fsSL https://relay.buzzrouter.com/install | sh` once (Node.js 20.11+ required), then `beeline pair <code>` once inside the first target repo. Bundle production is `npm run bundle:beeline`; deployable artifacts and the installer live under `relay-stack/web/`. `apps/body/src/runtime.ts` persists one Workspace-scoped identity/supervisor under the git common dir; `apps/body/src/supervisor.ts` discovers explicitly invited repository Rooms and runs one isolated `Body` per Room. Mobile's `＋ Agent` action attaches the same identity to another Room without CLI re-pairing. `beeline start` relaunches the supervisor. No `origin` creates a deliberately non-convergent local-only Room.
- With no `--agent`, `beeline pair` reuses preset resolution to auto-detect `codex`, `claude`, `goose`, and `pi`. Installed agents with missing ACP adapters remain visible on a TTY and offer the preset's exact npm install; non-interactive runs print the command without installing. A sole ready agent auto-selects, while several prompt on a TTY and fail closed otherwise. `reference` is an explicit-only fallback requiring an LLM key, and `custom` remains explicit-only and shell-free. Preset resolution and install metadata live in `apps/body/src/agent-command.ts`; runtime records persist the exact command/argv while retaining legacy `agentBinary` compatibility.
- Session control: `apps/body/src/session-scheduler.ts` pins `(agent, channel)` logical sessions, serializes each channel, bounds live ACP processes, and suspends idle LRU sessions. `apps/body/src/durable-state.ts` persists ordered inbox/cursors/delivery attempts and isolated conversation replay; active-corner input steers and `buzz-agent-cancel` cancels without dropping later input.
- Agent deletion is a real host teardown: `packages/buzz-client/src/agent.ts` removes the agent from every Room before removing its Workspace membership; `apps/body/src/supervisor.ts` treats that final projection loss as the durable-runtime lease ending, drains all Bodies/ACP sessions, and `apps/body/src/cli.ts` erases the machine-local runtime before exiting. Relay-backed proof: `apps/body/src/agent-removal.live.test.ts`.
- A paired Workspace-member agent creates its deterministic repo Room, makes the pairing human admin, then immediately projects itself as member (never admin). Buzz-relay origins provision the dedicated merge worker and enforce the protected-push assertion. User-hosted git origins use the operator's ambient credentials, but Body advances either target only after independently verifying an exact-tip signed approval from a device-held human admin; archive cleanup requires that approval plus the target-tip match. The agent completion path can only publish the feature ref and `merge-ready`. Live relay proof: `apps/body/src/pair-runtime.live.test.ts`, `github-origin.live.test.ts`, and `startup-protection.live.test.ts`.
- Current Room roles come from relay projections (39001 admins / 39002 members), not ordering kind:9000 history: rapid member→admin mutations can share a second-resolution timestamp. Authority readers and pairing convergence enforce this in `packages/buzz-client/src/repo-room.ts` and `apps/gate/src/provisioning.ts`.
- Internal compatibility path: `beeline serve <channel> <owner> <repo>` runs the older explicitly-wired single-Room loop. The supported paired daemon replies conversationally through the Room's read-only session when addressed (the sole other participant in a two-party Room, or an explicit `p=<agent pubkey>` mention in a multi-party Room). Only explicit open-a-corner commands open directly; ambiguous or implicit work uses the agent-originated write request + human ALLOW path. Parent Room lifecycle events drive the durable status card. The agent never pushes the protected branch.

## Release APK build (@beeline/mobile)

- `npm run apk:release` in `apps/mobile` builds a signed release APK (expo prebuild → patch signing config → gradle assembleRelease).
- Release keystore: `apps/mobile/android-signing/release.keystore` (stored pass in sibling README, rotate before public distribution).
- Configurable relay URL: persisted per-device via `buzz-identity-storage.ts`, default `https://relay.buzzrouter.com`.
- Onboarding/channels screens have a relay URL text field (editable).
- Gradle signing config is injected by `scripts/patch-android-signing.sh` after prebuild because the `android/` directory is gitignored.

## OIDC identity binding service (@beeline/auth)

- Authority and deployment shape: `apps/auth/README.md`; product invariants: `spec.md` → **Google-first identity binding security invariants**.
- The service owns Authorization Code + PKCE + nonce and a PostgreSQL-backed, hashed, one-use signed binding ceremony. It never accepts a free-standing ID token or grants relay, Room, role, or merge authority.
- Hermetic provider, adversarial protocol, JWKS rotation/stale-cache, and durable restart coverage: `npm test -w @beeline/auth`.
- Merge review custody is explicit in `apps/gate/src/worker.ts`: agent identity remains the first fail-closed check, and managed/remote reviewer keys are refused before role lookup.
- Native Google-first onboarding uses the strict bind client in `packages/buzz-client/src/oidc-bind.ts` and `apps/mobile/sources/app/(app)/buzz/onboarding.tsx`; reproduce the device flow with `npm run dev:emulator -w @beeline/auth` (see `apps/auth/README.md`). Web remains on the legacy advanced-key path until browser key storage is hardened.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Grok Mono Hull UI theme

- **Design tokens and mark authority**: `apps/mobile/sources/buzz/groknight.ts` owns grayscale semantic roles; `apps/mobile/sources/buzz/brand.json` owns the light mark color; and `apps/mobile/sources/buzz/beeline-mark.json` locks the approved continuous-line outline used by in-app and SVG assets. Regenerate platform art and both theme lockups with `apps/mobile/scripts/generate-monochrome-assets.sh`.
- **Design authority**: Grok Mono Hull. No chromatic state or brand color survives in Buzz. State is redundant through text, glyph, contrast, geometry, faint deterministic texture, reduced-motion-aware mechanical signals, and haptics. Shared primitives live in `apps/mobile/sources/components/buzz/MonoHull.tsx`.
- **Restyled screens**: `buzz/channels.tsx`, `buzz/chat/[channelId].tsx`, `buzz/onboarding.tsx` — session/channel list, live session transcript with merge controls and composer, and key onboarding.

## Mobile client (Happy fork)

- `apps/mobile` is a **vendored Happy** Expo app, **isolated** from root npm workspaces.
- Install: `npm run mobile:install` (or `cd apps/mobile && npm install`).
- EAS installs this isolated app without a root `node_modules`; keep optional monorepo paths in `metro.config.js` existence-guarded, and build file-linked `@beeline/*` packages through `eas-build-post-install`. Regression coverage: `sources/config/*Config.test.ts`.
- Typecheck: root `npm run typecheck` runs turbo + mobile tsc.
- Web: `npm run mobile:web` / `cd apps/mobile && npx expo start --web`.
- Buzz seam docs: `apps/mobile/BUZZ-SEAM.md`; interface: `sources/sync/transport/rig-transport.ts`.
- **BuzzRigTransport** (`sources/sync/transport/buzz-rig-transport.ts`): P1 implementation against `@beeline/buzz-client`. Covers: identity, sessionsRead, sessionRead, sessionEventsBackfill, sessionEventsSubscribe, messageSubmit. Everything else stubbed (RigTransportNotImplementedError).
- **Dependency strategy**: `@beeline/buzz-client` and `@beeline/nostr` are resolved via Metro `resolveRequest` aliases to their `dist/` in `../../packages/`. Transitive deps (`@noble/*`, `nostr-tools`) resolve via Metro's node_modules walk-up into the root workspace. See `metro.config.js` for the alias list. After SDK edits, build the root packages before a local `apk:release` so Metro cannot bundle stale `dist/` output.
- **Buzz UI screens** (`sources/app/(app)/buzz/`): parallel minimal path using BuzzRigTransport directly (no Happy sync layer). Onboarding, channel list, and chat screens.
- **Community shell**: `sources/components/buzz/CommunityRail.tsx` wraps Buzz screens; `buzz/channels.tsx` scopes channels to the selected community, and `join/[token].tsx` owns signed `relay.buzzrouter.com/join/<token>` preview, inline identity creation, and redemption. Selection persistence lives in `sources/buzz/community-storage.ts`.
- **Agent profiles**: `buzz/agents.tsx` pairs desktop/headless agent identities and joins them with human-signed, community-scoped overlays from `packages/buzz-client/src/agent.ts`. Name, personality, and intent are injected directly into ACP `session/new` instructions by `apps/body/src/persona-instructions.ts`, never written into repository files. Soul overlays carry no authority and never participate in gate enforcement.
- **Cosmetic identity**: deterministic single-word Agent names/handles live in `packages/buzz-client/src/display-name.ts`; authority-free person profiles and media upload live in `person-profile.ts` and `media.ts`. Mobile defaults are `AgentAvatar.tsx` (angular, gold-striped abstract bee) and `PersonAvatar.tsx` (soft grayscale flower), with custom images falling back to those pubkey-derived marks. Avatar uploads normalize to critical-chunk-only PNG because the relay rejects metadata-bearing containers.
- Typecheck: `npm run typecheck` at the repository root covers the isolated mobile app after the workspace packages.
- **P2 merge UI** (`apps/mobile/sources/app/(app)/buzz/chat/[channelId].tsx`): approve button in subchannels reads merge target from body-control messages (repo,branch,tip tags), signs P0-gate-shape approval via `submitMergeApproval`, shows async states. Merge-summary messages (t=merge-summary) render with green border. Archived subchannels (status=archived) disable text input. Provenance shows short npub next to each message.
- **Workspace/Room navigation** (`apps/mobile/sources/app/(app)/buzz/channels.tsx`): the person-facing unit for an agent subchannel is a **corner**. The top level is Rooms only, with corner counts and a live-work signal; tapping a Room opens `buzz/corners/[roomId].tsx`, the complete status list. Corner control events stay out of the Room transcript. Wire names remain `subchannel`/`change-review` for compatibility.
- **Body control message shape**: subchannel-open and intro messages now carry `["repo", ownerHex/repo]`, `["tip", 40-hex]` tags alongside existing `branch`, `subchannel`, `session`, `mode` tags. See `apps/body/src/body.ts` `openSubchannel()`.
- **`getSubchannelMergeTarget()`**: reads merge target from subchannel body-control messages in `BuzzRigTransport`. Used by the Approve button UI.
- **Change review wire**: Body computes the exact base→feature-tip manifest and chunked per-file patches before `merge-ready` (`apps/body/src/change-review.ts`). Protocol tags/types live in `packages/buzz-client/src/change-review.ts`; payloads use kind:30078 so they never consume kind:9 transcript backfill. Mobile fetches the manifest eagerly and each signed patch lazily through `BuzzRigTransport`. `scripts/ui-demo-provision.ts` creates a relay-backed review fixture without running an agent.
- **Merge approval wire**: `buildMergeApproval`/`submitMergeApproval` from `@beeline/buzz-client` produce kind:9 events with `t=buzz-merge-approval`, `repo`, `branch`, `tip` tags. Gate worker (`apps/gate/src/worker.ts`) verifies the exact binding. No workflow kinds (46010/46011/46012).
- **Corner authority boundary**: edit-mode ACP permissions are auto-approved inside the isolated corner worktree. The only human approval is the exact-tip collapse into the protected line, and the gate rejects every registered agent identity regardless of Room role.
- **Demo script**: `scripts/merge-demo.ts` exercises the full merge flow end-to-end against live relay.
- **Tradeoff**: the parallel screen path avoids deep refactoring of Happy's sync layer. If extending screens further, consider unifying with Happy's screen hierarchy.

## Android push notifications

- App registration lives in `apps/mobile/sources/push/buzz-push-registration.ts`; runtime defaults/overrides are in `app.config.js` and `sources/buzz/runtime-config.ts`. The public gateway default is `https://push.buzzrouter.com`.
- Notification presentation authority is `apps/push-gateway/src/mapping.ts`; cached recipient-authorized Room/sender resolution is in `metadata.ts`. Message previews are intentionally lock-screen-visible, while Android `tag`/FCM collapse keys replace rapid updates per Room.
- Gateway authority and operations: `apps/push-gateway/README.md`; durable production deployment is `apps/push-gateway/deploy/README.md`. Production reads use a host-loopback-only, query-only trusted relay sidecar that preserves the relay's per-recipient channel ACL, while event wakeups stay on the public auth-enforced relay. Credentials and device tokens must never be logged or committed.
- Gateway checks: `npm run build -w @beeline/push-gateway && npm test -w @beeline/push-gateway`.

## Community model

- SDK authority: `packages/buzz-client/src/community.ts`; gate convention + live proof: `apps/gate/src/community.live.test.ts`.
- Workspace pictures use the existing admin-gated kind:9002 metadata command and relay-signed kind:39000 projection; kind:9007 stays immutable and supplies the owner plus fallback picture. The relay's current projection preserves the namespaced picture URL through `purpose`; `community.ts` owns this compatibility convention.
- A community reuses NIP-29 group state: kind:9007 stream create with a self-referencing `community=<h UUID>` tag, kind:9000 roles, and 39001/39002 admin/member projections. Contained channels carry `community=<community UUID>`; absent remains a valid standalone channel.
- Workspace membership is asserted as direct membership in every live top-level Room for people: invite redemption skips corners, DMs, and archived Rooms while repairing existing Room membership, new community-linked Rooms mirror current human members, and self-listing Workspaces repairs historical/partial projections before mobile Room discovery. Registered agents are linked once at Workspace scope, never participate in that repair, and require an explicit per-Room attachment. Live proof: `packages/buzz-client/src/community-invite-visibility.live.test.ts`.
- Invites are signed kind:30078 lookup records (`t=buzz-community-invite`, `d=SHA-256(token)`, NIP-40 `expiration`). Token-only reads must use `findCommunityInvite`, which also scans the marker tag for legacy group-scoped kind:9 records because Buzz requires an unknown `h` to query those directly. Redemption validates the marker and self-adds through kind:9000; plaintext tokens are never published.
- Invite web authority is `relay-stack/nginx.conf`: the `relay-front` service owns the published relay port, serves `/join/bzi_*` plus both `/.well-known` app-association documents from `relay-stack/web/`, and proxies every other HTTP/WebSocket request to Buzz.

## Direct messages

- SDK authority: `packages/buzz-client/src/direct-message.ts`. A DM is a deterministic, private NIP-29 Room marked `t=buzz-dm`, bound immutably to one Workspace and two sorted participant pubkeys; SDK discovery requires the current projection to contain exactly those two members.
- Workspace membership propagation and Room/agent invite APIs skip or reject DMs, and mobile hides the Room member picker in DM chat. Agent DMs are discovered by `apps/body/src/supervisor.ts` and reuse the paired runtime's oldest repository Room as read-only conversation/edit-corner context.
