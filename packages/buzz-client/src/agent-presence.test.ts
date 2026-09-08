import { describe, expect, it } from 'vitest';
import {
  AGENT_PRESENCE_DORMANT_MS,
  AGENT_PRESENCE_STALE_MS,
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

describe('durable agent presence', () => {
  it('expires online state at the authenticated-evidence horizon', () => {
    expect(isAgentPresenceOnline(online, 1_000_000 + AGENT_PRESENCE_STALE_MS - 1)).toBe(true);
    expect(isAgentPresenceOnline(online, 1_000_000 + AGENT_PRESENCE_STALE_MS)).toBe(false);
    expect(isAgentPresenceOnline(online, 999_000)).toBe(true);
    expect(isAgentPresenceOnline({ ...online, status: 'offline' }, 1_000_000)).toBe(false);
  });

  it('lets explicit offline win a same-second tie and rejects stale replay', () => {
    expect(newerAgentPresence(online, { ...online, status: 'offline' }).status).toBe('offline');
    expect(newerAgentPresence(online, { ...online, observedAt: 999 })).toBe(online);
  });

  it('becomes dormant only after sustained absence', () => {
    expect(
      resolveAgentPresenceTier(
        { ...online, status: 'offline' },
        1_000_000 + AGENT_PRESENCE_DORMANT_MS - 1,
      ),
    ).toBe('offline');
    expect(
      resolveAgentPresenceTier(
        { ...online, status: 'offline' },
        1_000_000 + AGENT_PRESENCE_DORMANT_MS,
      ),
    ).toBe('dormant');
  });
});

describe('agent roster standing', () => {
  it('evicts only from server membership truth', () => {
    expect(
      resolveAgentRosterStanding({
        presence: online,
        membership: 'member',
        now: 1_000_000 + AGENT_PRESENCE_DORMANT_MS * 30,
      }),
    ).toEqual({ tier: 'dormant', lastSeenAt: 1_000 });
    expect(
      resolveAgentRosterStanding({ presence: online, membership: 'not-member', now: 1_000 }),
    ).toEqual({ tier: 'evicted' });
    expect(
      resolveAgentRosterStanding({ presence: undefined, membership: 'unknown', now: 1_000 }).tier,
    ).toBe('offline');
  });
});
