# `@buzzy/buzz-client`

Channel-scoped **client transport** for real Buzz. The mobile app’s `RigTransport`
adapter sits on this package. UI-agnostic — no React, no mock relay.

Authority: repo-root `spec.md` (Happy RigTransport ~10 methods + gotchas) and the
architecture scout report (`buzzy-arch-scout/report.md` §4 channels, §8 HTTP, §(c)
method→call table).

## What it covers

| Surface | API |
| --- | --- |
| Identity | `createIdentity`, `loadIdentityFromNsec`, `identityNpub` / `identityNsec` (via `@buzzy/nostr`) |
| Channel | `createChannel`, `addMember`, `listMembers`, `waitUntilMember`, `listMyChannels`, `getChannelMetadata` |
| Subchannel discovery | `createSubchannel` (child UUID + `parent` tag convention), `listSubchannels` |
| Messages | `messageSubmit` (kind:9, optional `#p` agent mention) |
| Live + backfill | `sessionEventsSubscribe` (WS NIP-01 + NIP-42 AUTH), `sessionEventsBackfill` (`POST /query`) |
| Agent activity bus | body-projected kind:9 with `#t=agent-activity` — classified on subscribe/backfill |
| Merge Approve | `buildMergeApproval` / `submitMergeApproval` — **P0 gate shape** (same tags as `@buzzy/gate`) |

### WebSocket choice

Core paths use the **platform `WebSocket` global** (`globalThis.WebSocket` — Node ≥22
and browsers). Inject `WebSocketImpl` for React Native. No Node-only `ws` package in
the core path, so the same client can be isomorphic once RN supplies a WS constructor.

Local open stack auth: `X-Pubkey` on HTTP bridge. Production: NIP-98 host-bound
(Host / `u` must match exactly — see `apps/gate/src/config.ts`).

### Gotchas encoded in the API

- **Accepted publish ≠ effect.** `addMember` returns the publish result; use
  `waitUntilMember` / `listMembers` (kind:39002) before trusting membership.
- **`h` tag must be a UUID.** Channel ids are always `crypto.randomUUID()`.
- **Role is a separate `["role", …]` tag** on kind:9000, not the NIP-29 p-slot.
- **Never rely on `require-approval` git policy** (not enforced). Merge approval is
  the signed kind:9 marker the gate worker verifies.

## Scripts

```sh
# From packages/buzz-client (or via turbo filters):
npm test              # hermetic unit tests (no relay)
npm run test:live     # live suite against real relay
                      # pretest:live builds @buzzy/nostr + this package
npm run typecheck
npm run build
```

```sh
# From monorepo root:
npm run stack:up
cd packages/buzz-client && npm run test:live
```

If the relay is unreachable, live tests soft-skip and exit 0. When the relay **is**
reachable they always run for real.

## What the RigTransport adapter still needs

This package is the **relay transport** half. The Happy `RigTransport` (~10 MVP
methods in `spec.md`) also needs a **body** (operator machine) that:

| RigTransport | Still on the body / later |
| --- | --- |
| `sessionCreate` / `sessionRead` / `sessionsRead` / `sessionArchive` | ACP stdio (`buzz-acp` ↔ `buzz-agent`); map channel↔session body-side |
| `messageSubmit` → agent turn | kind:9 + `#p` agent (this package) → buzz-acp `session/prompt` |
| `sessionEventsSubscribe` live tool UI | Body must **project** ACP `session/update` as `#t=agent-activity` channel events (stdio is not multi-user) |
| `runAbort` | Owner `!cancel` mention or body control → ACP `session/cancel` |
| Permission respond | Body-mediated; stock buzz-acp auto-approves today |
| `worktreeCreate` / `worktreeArchive` | Body: git worktree + child channel + edit MCP |
| `changedFileRead` / `workspaceFilesRead` / revert | No relay file REST — body `git show`/`diff` or client smart-HTTP fetch |
| Merge Approve | **This package** signs P0 kind:9 grant; worker in `apps/gate` lands the merge |
| Terminals | Stub / hide UI (no Buzz PTY) |

See scout report §(c) for the full method→call sequence and §(a) for the
mobile ↔ relay ↔ body diagram.

## Live proofs

1. **Round-trip** — A creates channel, adds B; both WS-connected; cross-send + ordered backfill.
2. **Two-participants** — two concurrent sockets, distinct keys; body publishes agent-activity; both receive; both submit.
3. **Membership effect** — after kind:9000, assert 39002 before proceeding.

## Usage sketch

```ts
import {
  createIdentity,
  createBuzzClient,
} from '@buzzy/buzz-client';

const me = createIdentity();
const client = createBuzzClient({
  baseUrl: 'http://127.0.0.1:3010',
  identity: me,
  // WebSocketImpl: RNWebSocket,  // when on React Native
});

const channelId = await client.createChannel('my-tlc');
await client.addMember(channelId, otherPubkey, 'member');
await client.waitUntilMember(channelId, otherPubkey); // assert effect

await client.connect();
const stop = await client.sessionEventsSubscribe(channelId, (ev) => {
  if (ev.kind === 'agent-activity') { /* tool UI */ }
  else { /* chat */ }
});

await client.messageSubmit(channelId, 'ship it', { mentionAgent: agentPubkey });
const history = await client.sessionEventsBackfill(channelId, { limit: 100 });

const approval = client.buildMergeApproval(channelId, {
  repo: `${ownerHex}/repo`,
  branch: 'refs/heads/main',
  tip: featureTip40Hex,
});
await client.publish(approval);
```
