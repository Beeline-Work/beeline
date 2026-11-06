import { describe, expect, it } from 'vitest';
import { AGENT_PRESENCE_DORMANT_MS, AGENT_PRESENCE_STALE_MS } from '@beeline/buzz-client';
import {
  activeMentionCandidates,
  agentPresenceTier,
  isAgentTurnActive,
  mergeAgentPresence,
  mergeAgentPresenceBatch,
  nextAgentPresenceTransitionAt,
  type RoomAgentPresence,
} from './agent-presence';

const agent = 'b'.repeat(64);
const presence: RoomAgentPresence = { agentPubkey: agent, status: 'online', observedAt: 0 };

describe('mobile live presence overlay', () => {
  it('schedules and applies authenticated-evidence expiry', () => {
    expect(nextAgentPresenceTransitionAt({ [agent]: presence }, 0)).toBe(AGENT_PRESENCE_STALE_MS);
    expect(agentPresenceTier(presence, AGENT_PRESENCE_STALE_MS - 1)).toBe('online');
    expect(agentPresenceTier(presence, AGENT_PRESENCE_STALE_MS)).toBe('offline');
    expect(agentPresenceTier(presence, AGENT_PRESENCE_DORMANT_MS)).toBe('dormant');
  });

  it('never schedules an expiry for presence a live connection holds', () => {
    const held: RoomAgentPresence = { ...presence, held: true };
    expect(nextAgentPresenceTransitionAt({ [agent]: held }, 0)).toBe(AGENT_PRESENCE_DORMANT_MS);
    expect(agentPresenceTier(held, AGENT_PRESENCE_STALE_MS * 10)).toBe('online');
    expect(agentPresenceTier({ ...held, status: 'offline' }, 1)).toBe('offline');
  });

  it('keeps offline agents addressable but excludes dormant agents', () => {
    const candidates = [{ pubkey: agent }, { pubkey: 'c'.repeat(64) }];
    expect(
      activeMentionCandidates(
        candidates,
        { [agent]: { ...presence, status: 'offline' } },
        AGENT_PRESENCE_DORMANT_MS,
      ),
    ).toEqual([candidates[1]]);
  });

  it('keeps working turns until a committed terminal projection arrives', () => {
    const turn = {
      requestId: 'request-1', agentPubkey: agent, status: 'working' as const,
      generationId: 'pending:abc', createdAt: 0,
    };
    expect(isAgentTurnActive(turn)).toBe(true);
    expect(isAgentTurnActive({ ...turn, generationId: 'old' })).toBe(true);
    expect(isAgentTurnActive({ ...turn, status: 'complete' })).toBe(false);
    expect(isAgentTurnActive({ ...turn, status: 'failed' })).toBe(false);
    const current = { ...presence, observedAt: 100, generationId: 'new' };
    expect(mergeAgentPresence({ [agent]: current }, { ...presence, observedAt: 10 })[agent]).toBe(current);
  });

  it('keeps a newer live heartbeat when a Room refetch has no presence row', () => {
    const live = { ...presence, observedAt: 20 };
    const server = { ...presence, observedAt: 10 };
    expect(mergeAgentPresenceBatch({ [agent]: live }, [])).toEqual({ [agent]: live });
    expect(mergeAgentPresenceBatch({ [agent]: live }, [server])).toEqual({ [agent]: live });
    expect(mergeAgentPresenceBatch({ [agent]: server }, [{ ...presence, observedAt: 30 }])).toEqual(
      { [agent]: { ...presence, observedAt: 30 } },
    );
  });
});
