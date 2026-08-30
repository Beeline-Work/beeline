# `@beeline/buzz-client`

Channel-scoped **client transport** for real Buzz. The mobile app’s `RigTransport`
adapter sits on this package. UI-agnostic — no React, no mock relay.

Authority: the repository's [surface boundary](../../AGENTS.md) and the exported
types in [`src/room-view.ts`](./src/room-view.ts).

## What it covers

| Surface              | API                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity             | `createIdentity`, `loadIdentityFromNsec`, `identityNpub` / `identityNsec` (via `@beeline/nostr`)                                                   |
| Agent entity         | `createAgentIdentity`, `createAgent`, `listAgents`, `isAgentIdentity` — self-signed community records with optional soul/personality/avatar fields |
| Channel              | `createChannel`, `addMember`, `listMembers`, `waitUntilMember`, `listMyChannels`, `getChannelMetadata`                                             |
| Community            | `createCommunity`, `listCommunities`, `communityMembers`, `communityChannels`                                                                      |
| Invite               | `createInvite`, `redeemInvite` (signed, expiring, repeat-safe join)                                                                                |
| Subchannel discovery | `createSubchannel` (child UUID + `parent` tag convention), `listSubchannels`                                                                       |
| Messages             | `messageSubmit` (kind:9, optional `#p` agent mention)                                                                                              |
| Live + backfill      | `sessionEventsSubscribe` (WS NIP-01 + NIP-42 AUTH), `sessionEventsBackfill` (`POST /query`)                                                        |
| Agent activity bus   | body-projected kind:9 with `#t=agent-activity` — classified on subscribe/backfill                                                                  |
| Permission ledger    | signed request/decision/revocation/execution wire types, including the attenuated `mission.control` boundary                                       |
| Schedule receipts    | deterministic run ids plus signed queued/working/complete/failed/skipped receipt builders and parsers                                              |
| Merge Approve        | `buildMergeApproval` / `submitMergeApproval` — **P0 gate shape** (same tags as `@beeline/gate`)                                                    |

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
- **Community is the same group model.** Its kind:9007 `community` tag points
  to its own `h` UUID; contained channels point that tag to the community.
- **Invite plaintext never lands on-relay.** A signed kind:9 marker stores its
  SHA-256 hash and NIP-40 `expiration`; redemption self-adds through kind:9000.
- **Agent is an identity, not a role.** A `#t=buzz-agent` record is self-signed
  by the agent key and points to its community. Optional soul/personality/avatar
  values are caller-supplied metadata; this package never generates them.
- **Never rely on `require-approval` git policy** (not enforced). Merge approval is
  the signed kind:9 marker the gate worker verifies.

## Scripts

```sh
# From packages/buzz-client (or via turbo filters):
npm test              # hermetic unit tests (no relay)
npm run test:live     # live suite against real relay
                      # pretest:live builds @beeline/nostr + this package
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

## Current boundaries

- **Relay transport:** this package signs relay writes and offers HTTP/WS query helpers.
- **Durable reads:** [`RoomViewClient`](./src/room-view.ts) verifies server-indexed Room,
  history, Workspace, and agent-detail responses before a client can cache or render them.
- **Live updates:** relay signals invalidate those surfaces; only verified draft, thought, and
  presence events may appear as live overlays.
- **Execution:** [`apps/body`](../../apps/body) owns ACP sessions, permission requests,
  worktrees, and agent execution. This package does not own a Room snapshot or auto-approve
  those actions.

## Live proofs

1. **Round-trip** — A creates channel, adds B; both WS-connected; cross-send + ordered backfill.
2. **Two-participants** — two concurrent sockets, distinct keys; body publishes agent-activity; both receive; both submit.
3. **Membership effect** — after kind:9000, assert 39002 before proceeding.

## Usage sketch

```ts
import { createAgentIdentity, createIdentity, createBuzzClient } from '@beeline/buzz-client';

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
  if (ev.kind === 'agent-activity') {
    /* tool UI */
  } else {
    /* chat */
  }
});

await client.messageSubmit(channelId, 'ship it', { mentionAgent: agentPubkey });
const history = await client.sessionEventsBackfill(channelId, { limit: 100 });

const approval = client.buildMergeApproval(channelId, {
  repo: `${ownerHex}/repo`,
  branch: 'refs/heads/main',
  tip: featureTip40Hex,
});
await client.publish(approval);

const communityId = await client.createCommunity('Acme');
await client.waitUntilMember(communityId, me.publicKey);
const generalId = await client.createChannel('general', { communityId });
const invite = await client.createInvite(communityId, { expiresInSeconds: 86_400 });

// On a second device/identity:
await otherClient.redeemInvite(invite.token);
const restored = await otherClient.listCommunities();
const channels = await otherClient.communityChannels(communityId);

// A separate key joins as a member, then self-registers as an agent.
const agentIdentity = createAgentIdentity('Patch');
const agentClient = createBuzzClient({ baseUrl: client.baseUrl, identity: agentIdentity });
await client.addMember(communityId, agentIdentity.publicKey, 'member');
await agentClient.waitUntilMember(communityId, agentIdentity.publicKey);
await agentClient.createAgent(communityId, { displayName: 'Patch' });
const agents = await client.listAgents(communityId);
```
