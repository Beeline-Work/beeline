import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signEvent, type NostrEvent, type UnsignedEvent } from '@beeline/nostr';
import { describe, expect, it } from 'vitest';
import { createIdentity } from './identity.js';
import {
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  KIND_STREAM_MESSAGE,
  TAG_PARENT,
} from './kinds.js';
import { parseRelayEvent } from './read-model/parser.js';
import {
  createWorkspaceSnapshot,
  reduceWorkspaceEvents,
  reduceWorkspaceSnapshot,
} from './read-model/reducer.js';
import { selectCorners, selectMembers, selectTranscript } from './read-model/selectors.js';
import type { IdentityRecord, ParseAuthority, Pubkey } from './read-model/types.js';
import {
  AGENT_PRESENCE_DORMANT_MS,
  AGENT_PRESENCE_STALE_MS,
  agentPresenceKey,
  isAgentPresenceOnline,
  newerAgentPresence,
  resolveAgentPresenceTier,
  resolveAgentRosterStanding,
  type AgentPresence,
} from './agent-presence.js';

const online: AgentPresence = {
  agentPubkey: 'a'.repeat(64),
  status: 'online',
  observedAt: 1_000,
};

describe('agent presence lease', () => {
  it('expires an online heartbeat after the staleness window', () => {
    expect(isAgentPresenceOnline(online, 1_000 + AGENT_PRESENCE_STALE_MS)).toBe(true);
    expect(isAgentPresenceOnline(online, 1_001 + AGENT_PRESENCE_STALE_MS)).toBe(false);
    expect(isAgentPresenceOnline({ ...online, status: 'offline' }, 1_000)).toBe(false);
    expect(isAgentPresenceOnline(undefined, 1_000)).toBe(false);
  });

  it('tolerates the daemon clock running ahead of the reader (ordinary clock skew)', () => {
    // A live agent whose observedAt lands after the reader's own `now` must
    // still read online — this is the bug: a stale-forever "AGENT OFFLINE"
    // banner for a genuinely online, actively-replying agent.
    expect(isAgentPresenceOnline(online, 999)).toBe(true);
    expect(isAgentPresenceOnline(online, 1_000 - AGENT_PRESENCE_STALE_MS)).toBe(true);
    expect(isAgentPresenceOnline(online, 999 - AGENT_PRESENCE_STALE_MS)).toBe(false);
  });

  it('lets an explicit offline marker win a same-second timestamp tie', () => {
    expect(newerAgentPresence(online, { ...online, status: 'offline' }).status).toBe('offline');
    expect(newerAgentPresence({ ...online, status: 'offline' }, online).status).toBe('offline');
    expect(
      newerAgentPresence(online, { ...online, status: 'offline', observedAt: 2_000 }).status,
    ).toBe('offline');
  });
});

/**
 * A presence record is a parameterized-replaceable kind:30078 event, and the
 * relay indexes those by `d`. A `#h` filter over kind 30078 matches NOTHING —
 * even though the record does carry an `h` tag — so a reader that asks by `#h`
 * silently sees no presence at all and reports every agent offline forever.
 *
 * That is not a hypothetical: the Workspace-wide agents directory asked by
 * `#h` and did exactly this, while the per-Room readers (which spelled the `d`
 * key out by hand) worked. `agentPresenceKey` is the one builder they all
 * share now, and this is the assertion that keeps a future reader from
 * reaching for the tag that looks right and isn't.
 */
describe('agent presence tier (lease lapse / dormant)', () => {
  it('reads online exactly while the lease holds, offline the instant it lapses', () => {
    expect(resolveAgentPresenceTier(online, 1_000 + AGENT_PRESENCE_STALE_MS)).toBe('online');
    expect(resolveAgentPresenceTier(online, 1_001 + AGENT_PRESENCE_STALE_MS)).toBe('offline');
    // An explicit offline marker and a missing record are both immediately offline.
    expect(resolveAgentPresenceTier({ ...online, status: 'offline' }, 1_000)).toBe('offline');
    expect(resolveAgentPresenceTier(undefined, 1_000)).toBe('offline');
  });

  it('turns dormant only after the documented sustained-absence grace', () => {
    // Dormancy is measured from the last heartbeat, same anchor as the lease.
    expect(resolveAgentPresenceTier(online, 1_000 + AGENT_PRESENCE_DORMANT_MS - 1)).toBe('offline');
    expect(resolveAgentPresenceTier(online, 1_000 + AGENT_PRESENCE_DORMANT_MS)).toBe('dormant');
    expect(
      resolveAgentPresenceTier({ ...online, status: 'offline' }, 1_000 + AGENT_PRESENCE_DORMANT_MS),
    ).toBe('dormant');
  });

  it('never ages an agent into dormancy across clock boundaries or skew', () => {
    // A far-future stamp (reader clock behind) yields NEGATIVE elapsed time;
    // it must not satisfy dormancy any more than a forward one would.
    expect(resolveAgentPresenceTier(online, 1_000 - AGENT_PRESENCE_DORMANT_MS * 10)).not.toBe(
      'dormant',
    );
    // A modestly-behind reader clock inside the lease window still reads
    // online — the same skew tolerance the lease door grants.
    expect(resolveAgentPresenceTier(online, 0)).toBe('online');
    // Beyond the lease on the past side it reads honestly offline.
    expect(resolveAgentPresenceTier(online, 999 - AGENT_PRESENCE_STALE_MS)).toBe('offline');
  });

  it('is stable against out-of-order and stale duplicate records', () => {
    // The caller hands one already-reduced record (`newerAgentPresence`); an
    // older heartbeat replayed after the lease lapsed cannot resurrect it.
    const reduced = newerAgentPresence(online, { ...online, observedAt: 500 });
    expect(reduced.observedAt).toBe(1_000);
    expect(resolveAgentPresenceTier(reduced, 1_000 + AGENT_PRESENCE_DORMANT_MS * 2)).toBe(
      'dormant',
    );
    // An older OFFLINE marker never overrides a newer online one either.
    const newest = newerAgentPresence(online, { ...online, status: 'offline', observedAt: 999 });
    expect(newest.status).toBe('online');
  });
});

describe('agent roster standing (eviction vs flake)', () => {
  it('evicts ONLY on signed membership removal truth, never on elapsed darkness', () => {
    // Days of silence with membership intact: dormant, not evicted. This is
    // the Clara shape — a reaped process must dim out, not vanish.
    expect(
      resolveAgentRosterStanding({
        presence: online,
        membership: 'member',
        now: 1_000 + AGENT_PRESENCE_DORMANT_MS * 30,
      }),
    ).toEqual({ tier: 'dormant', lastSeenAt: 1_000 });
    // A successful read saying the key was durably removed evicts outright,
    // even over a still-fresh heartbeat: roster truth outranks presence.
    expect(
      resolveAgentRosterStanding({ presence: online, membership: 'not-member', now: 1_000 }),
    ).toEqual({ tier: 'evicted' });
  });

  it('degrades unknown membership DOWN to the presence tiers, never to eviction', () => {
    // A failed/degraded read is exactly how one relay blip could otherwise
    // erase a live agent; unknown can only ever look like the lease says.
    expect(
      resolveAgentRosterStanding({
        presence: online,
        membership: 'unknown',
        now: 1_000 + AGENT_PRESENCE_DORMANT_MS * 30,
      }).tier,
    ).toBe('dormant');
    expect(
      resolveAgentRosterStanding({ presence: undefined, membership: 'unknown', now: 1_000 }).tier,
    ).toBe('offline');
  });

  it('removes one Room key idempotently, preserves history, and reverses on re-pair', () => {
    const room = 'presence-room';
    const otherRoom = 'presence-other-room';
    const corner = 'presence-corner';
    const workspace = 'presence-workspace';
    const owner = createIdentity('presence-owner');
    const pairedAgent = createIdentity('presence-agent');
    const relay = createIdentity('presence-relay');
    const ownerRecord: IdentityRecord = {
      kind: 'human',
      pubkey: owner.publicKey as Pubkey,
      displayName: 'Captain',
      revision: '1',
    };
    const agentRecord: IdentityRecord = {
      kind: 'agent',
      pubkey: pairedAgent.publicKey as Pubkey,
      displayName: 'Clara',
      revision: '1',
    };
    const authority: ParseAuthority = {
      workspaceId: workspace,
      identities: {
        [owner.publicKey]: ownerRecord,
        [pairedAgent.publicKey]: agentRecord,
      },
      channelCreators: {
        [room]: owner.publicKey,
        [otherRoom]: owner.publicKey,
        [corner]: pairedAgent.publicKey,
      },
      channelAdmins: {
        [room]: [owner.publicKey],
        [otherRoom]: [owner.publicKey],
        [corner]: [owner.publicKey],
      },
      trustedProjectionPubkeys: [relay.publicKey],
    };
    const signed = (source: typeof owner, input: Omit<UnsignedEvent, 'pubkey'>): NostrEvent =>
      signEvent({ ...input, pubkey: source.publicKey }, source.secretKey);
    const memberSnapshot = (channelId: string): NostrEvent =>
      signed(relay, {
        created_at: 1,
        kind: KIND_CHANNEL_MEMBERS,
        tags: [
          ['d', channelId],
          ['p', owner.publicKey, 'owner'],
          ['p', pairedAgent.publicKey, 'member'],
        ],
        content: '',
      });
    const initial = reduceWorkspaceEvents(
      createWorkspaceSnapshot({
        workspaceId: workspace,
        identities: [ownerRecord, agentRecord],
      }),
      [
        memberSnapshot(room),
        memberSnapshot(otherRoom),
        signed(pairedAgent, {
          created_at: 2,
          kind: KIND_STREAM_MESSAGE,
          tags: [['h', room]],
          content: 'Historical answer',
        }),
        signed(pairedAgent, {
          created_at: 3,
          kind: KIND_CREATE_GROUP,
          tags: [
            ['h', corner],
            [TAG_PARENT, room],
            ['p', owner.publicKey, 'owner'],
            ['p', pairedAgent.publicKey, 'member'],
          ],
          content: '',
        }),
      ].map((event) => parseRelayEvent(event, authority)),
    );
    const transcriptBefore = selectTranscript(initial, room);
    const cornersBefore = selectCorners(initial, room);
    const removal = parseRelayEvent(
      signed(owner, {
        created_at: 4,
        kind: KIND_REMOVE_USER,
        tags: [
          ['h', room],
          ['p', pairedAgent.publicKey],
        ],
        content: '',
      }),
      authority,
    );
    const removed = reduceWorkspaceSnapshot(initial, removal);
    const membershipStanding = selectMembers(removed, room).some(
      (member) => member.pubkey === pairedAgent.publicKey,
    )
      ? 'member'
      : 'not-member';

    expect(
      resolveAgentRosterStanding({ presence: online, membership: membershipStanding }),
    ).toEqual({ tier: 'evicted' });
    expect(reduceWorkspaceSnapshot(removed, removal)).toBe(removed);
    expect(selectMembers(removed, otherRoom).map((member) => member.pubkey)).toContain(
      pairedAgent.publicKey,
    );
    expect(selectTranscript(removed, room)).toEqual(transcriptBefore);
    expect(selectCorners(removed, room)).toEqual(cornersBefore);

    const restored = reduceWorkspaceSnapshot(
      removed,
      parseRelayEvent(
        signed(owner, {
          created_at: 5,
          kind: KIND_PUT_USER,
          tags: [
            ['h', room],
            ['p', pairedAgent.publicKey],
            ['role', 'member'],
          ],
          content: '',
        }),
        authority,
      ),
    );
    const restoredMembership = selectMembers(restored, room).some(
      (member) => member.pubkey === pairedAgent.publicKey,
    )
      ? 'member'
      : 'not-member';
    expect(
      resolveAgentRosterStanding({
        presence: { ...online, agentPubkey: pairedAgent.publicKey },
        membership: restoredMembership,
        now: 1_100,
      }),
    ).toEqual({ tier: 'online', lastSeenAt: 1_000 });
  });
});

describe('presence is addressed by `d`, never by `h`', () => {
  const source = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

  it('builds the key the publisher writes', () => {
    expect(agentPresenceKey('7f2f9a35-eadd-4a25-812c-25deb554448d')).toBe(
      'agent-presence:7f2f9a35-eadd-4a25-812c-25deb554448d',
    );
  });

  it('never filters a presence read by `#h` anywhere in the client', () => {
    const client = source('client.ts');
    for (const [index, line] of client.split('\n').entries()) {
      if (!line.includes('KIND_AGENT_PRESENCE')) continue;
      // The filter object is the few lines around the kind.
      const window = client
        .split('\n')
        .slice(index, index + 4)
        .join('\n');
      expect(window, `client.ts:${index + 1} filters presence by #h`).not.toContain("'#h'");
    }
    expect(client).toContain('agentPresenceKey(channelId)');
  });

  it('leaves nobody spelling the key out by hand', () => {
    // A second literal is how the publisher and the readers drift apart.
    expect(source('client.ts')).not.toContain('`agent-presence:');
  });
});
