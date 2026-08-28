import { describe, expect, it } from 'vitest';
import { AGENT_PRESENCE_DORMANT_MS, AGENT_PRESENCE_STALE_MS } from '@beeline/buzz-client';
import {
  AGENT_TURN_FRESHNESS_MS,
  activeMentionCandidates,
  agentPresenceTier,
  isAgentTurnActive,
  mergeAgentPresence,
  mergeAgentPresenceBatch,
  nextAgentPresenceTransitionAt,
  nextAgentTurnExpiryAt,
  onlineVerdicts,
  type RoomAgentPresence,
} from './agent-presence';

const agent = 'b'.repeat(64);
const presence: RoomAgentPresence = { agentPubkey: agent, status: 'online', observedAt: 0 };

describe('mobile live presence overlay', () => {
  it('schedules lease and dormancy transitions without durable transcript state', () => {
    expect(nextAgentPresenceTransitionAt({ [agent]: presence }, 0)).toBe(AGENT_PRESENCE_STALE_MS);
    expect(agentPresenceTier(presence, AGENT_PRESENCE_STALE_MS + 1)).toBe('offline');
    expect(agentPresenceTier(presence, AGENT_PRESENCE_DORMANT_MS)).toBe('dormant');
  });

  it('keeps offline agents addressable but excludes dormant agents', () => {
    const candidates = [{ pubkey: agent }, { pubkey: 'c'.repeat(64) }];
    expect(
      activeMentionCandidates(candidates, { [agent]: presence }, AGENT_PRESENCE_DORMANT_MS),
    ).toEqual([candidates[1]]);
  });

  it('uses replaceable latest-value semantics and current daemon generation', () => {
    const now = 100_000;
    const current = { ...presence, observedAt: now, generationId: 'new' };
    expect(mergeAgentPresence({ [agent]: current }, { ...presence, observedAt: 10 })[agent]).toBe(
      current,
    );
    expect(
      isAgentTurnActive(
        {
          requestId: '1'.repeat(64),
          agentPubkey: agent,
          status: 'working',
          generationId: 'new',
          createdAt: 100,
        },
        current,
        now,
      ),
    ).toBe(true);
    expect(
      isAgentTurnActive(
        {
          requestId: '1'.repeat(64),
          agentPubkey: agent,
          status: 'working',
          generationId: 'old',
          createdAt: 100,
        },
        current,
        now,
      ),
    ).toBe(false);
  });

  it('expires an abandoned working receipt after 90 seconds and schedules that repaint', () => {
    const turn = {
      requestId: '1'.repeat(64),
      agentPubkey: agent,
      status: 'working' as const,
      createdAt: 100,
    };
    const deadline = 100_000 + AGENT_TURN_FRESHNESS_MS;

    expect(isAgentTurnActive(turn, undefined, deadline - 1)).toBe(true);
    expect(nextAgentTurnExpiryAt([turn], 100_000)).toBe(deadline);
    expect(isAgentTurnActive(turn, undefined, deadline)).toBe(false);
    expect(nextAgentTurnExpiryAt([turn], deadline)).toBeUndefined();
    expect(isAgentTurnActive({ ...turn, status: 'complete' }, undefined, 100_001)).toBe(false);
    expect(isAgentTurnActive({ ...turn, status: 'failed' }, undefined, 100_001)).toBe(false);
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

  it('resolves one stable online verdict per requested agent', () => {
    expect(
      onlineVerdicts({ [agent]: { ...presence, observedAt: 1_000 } }, [agent, 'missing'], 1_000),
    ).toEqual({ [agent]: true, missing: false });
  });
});
