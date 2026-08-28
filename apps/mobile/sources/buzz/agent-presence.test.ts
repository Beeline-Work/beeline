import { describe, expect, it } from 'vitest';
import { AGENT_PRESENCE_DORMANT_MS, AGENT_PRESENCE_STALE_MS } from '@beeline/buzz-client';
import {
  activeMentionCandidates,
  agentPresenceTier,
  isAgentTurnActive,
  mergeAgentPresence,
  nextAgentPresenceTransitionAt,
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
    const current = { ...presence, observedAt: 20, generationId: 'new' };
    expect(mergeAgentPresence({ [agent]: current }, { ...presence, observedAt: 10 })[agent]).toBe(
      current,
    );
    expect(
      isAgentTurnActive(
        { requestId: 'r', agentPubkey: agent, status: 'working', generationId: 'new' },
        current,
      ),
    ).toBe(true);
    expect(
      isAgentTurnActive(
        { requestId: 'r', agentPubkey: agent, status: 'working', generationId: 'old' },
        current,
      ),
    ).toBe(false);
  });

  it('resolves one stable online verdict per requested agent', () => {
    expect(
      onlineVerdicts({ [agent]: { ...presence, observedAt: 1_000 } }, [agent, 'missing'], 1_000),
    ).toEqual({ [agent]: true, missing: false });
  });
});
