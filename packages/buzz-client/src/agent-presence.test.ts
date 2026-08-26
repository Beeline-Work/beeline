import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
    // An explicit offline marker and a missing record are both honest
    // `offline` — never online, never dormant.
    expect(resolveAgentPresenceTier({ ...online, status: 'offline' }, 1_000)).toBe('offline');
    expect(resolveAgentPresenceTier(undefined, 1_000)).toBe('offline');
  });

  it('turns dormant only after the documented sustained-absence grace', () => {
    // Dormancy is measured from the last heartbeat, same anchor as the lease.
    expect(resolveAgentPresenceTier(online, 1_000 + AGENT_PRESENCE_DORMANT_MS - 1)).toBe(
      'offline',
    );
    expect(resolveAgentPresenceTier(online, 1_000 + AGENT_PRESENCE_DORMANT_MS)).toBe('dormant');
  });

  it('never ages an agent into dormancy across clock boundaries or skew', () => {
    // A far-future stamp (reader clock behind) yields NEGATIVE elapsed time;
    // it must not satisfy dormancy any more than a forward one would.
    expect(
      resolveAgentPresenceTier(online, 1_000 - AGENT_PRESENCE_DORMANT_MS * 10),
    ).not.toBe('dormant');
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

  it('preserves history: eviction re-derives standing without touching any event data', () => {
    // Eviction is a derived read over relay truth. It must not rewrite,
    // retract, or orphan a single historical fact: the presence record goes
    // in unchanged and messages/corners/receipts are never inputs at all.
    const record: AgentPresence = { ...online };
    resolveAgentRosterStanding({ presence: record, membership: 'not-member', now: 1_000 });
    expect(record).toEqual(online);
  });

  it('returns a renewed identity to the active tier cleanly, idempotently', () => {
    const standing = (): unknown =>
      resolveAgentRosterStanding({ presence: online, membership: 'member', now: 1_100 });
    // Re-derivation (every poll tick, every screen mount) is stable — there
    // is no side effect to duplicate a roster entry with.
    expect(standing()).toEqual(standing());
    expect(resolveAgentRosterStanding({ presence: online, membership: 'member', now: 1_100 })).toEqual(
      { tier: 'online', lastSeenAt: 1_000 },
    );
    // And a re-paired (membership restored) key reads active again, not
    // stuck evicted by any local memory of the earlier removal.
    expect(
      resolveAgentRosterStanding({ presence: online, membership: 'member', now: 1_100 }).tier,
    ).toBe('online');
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
      const window = client.split('\n').slice(index, index + 4).join('\n');
      expect(window, `client.ts:${index + 1} filters presence by #h`).not.toContain("'#h'");
    }
    expect(client).toContain('agentPresenceKey(channelId)');
  });

  it('leaves nobody spelling the key out by hand', () => {
    // A second literal is how the publisher and the readers drift apart.
    expect(source('client.ts')).not.toContain("`agent-presence:");
  });
});
