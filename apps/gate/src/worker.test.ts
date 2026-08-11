import { describe, expect, it } from 'vitest';
import { signEvent } from '@beeline/nostr';
import { newIdentity } from './identity.js';
import { authorizeReviewer, roomMergeCandidates } from './worker.js';

describe('durable Room merge discovery', () => {
  it('accepts only signed agent-authored openings for the configured repo and target', () => {
    const agent = newIdentity('agent');
    const ownerHex = 'a'.repeat(64);
    const config = { ownerHex, repo: 'project', targetBranch: 'main' };
    const opening = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: 1,
        kind: 9,
        tags: [
          ['h', '11111111-1111-4111-8111-111111111111'],
          ['t', 'body-control'],
          ['status', 'open'],
          ['repo', `${ownerHex}/project`],
          ['branch', 'refs/heads/main'],
          ['subchannel', '22222222-2222-4222-8222-222222222222'],
          ['feature', 'feature/change-one'],
          ['agent', agent.publicKey],
        ],
        content: 'opened',
      },
      agent.secretKey,
    );

    expect(roomMergeCandidates([opening], config)).toEqual([
      {
        subchannelId: '22222222-2222-4222-8222-222222222222',
        featureBranch: 'feature/change-one',
        agentPubkey: agent.publicKey,
      },
    ]);
    expect(
      roomMergeCandidates(
        [
          { ...opening, tags: opening.tags.map((tag) => [...tag]) },
          signEvent(
            {
              pubkey: agent.publicKey,
              created_at: 2,
              kind: 9,
              tags: opening.tags.map((tag) =>
                tag[0] === 'repo' ? ['repo', `${ownerHex}/other`] : [...tag],
              ),
              content: 'wrong repo',
            },
            agent.secretKey,
          ),
        ],
        config,
      ),
    ).toHaveLength(1);
  });
});

describe('trusted reviewer security invariants', () => {
  const input = {
    pubkey: 'a'.repeat(64),
    queryPubkey: 'b'.repeat(64),
    channelId: '11111111-1111-4111-8111-111111111111',
    custody: 'device' as const,
  };

  it('checks the registered-agent identity first and refuses an OIDC-bound agent before role', async () => {
    const calls: string[] = [];
    const result = await authorizeReviewer(input, {
      isRegisteredAgent: async () => {
        calls.push('agent');
        return true;
      },
      resolveRole: async () => {
        calls.push('role');
        return 'admin';
      },
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/registered agent identity/);
    expect(calls).toEqual(['agent']);
  });

  it('fails closed on agent-registry outage without consulting roles', async () => {
    const calls: string[] = [];
    const result = await authorizeReviewer(input, {
      isRegisteredAgent: async () => {
        calls.push('agent');
        throw new Error('registry unavailable');
      },
      resolveRole: async () => {
        calls.push('role');
        return 'owner';
      },
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/cannot prove approval signer is human/);
    expect(calls).toEqual(['agent']);
  });

  it.each(['managed', 'remote'] as const)(
    'refuses %s human reviewer keys before role lookup',
    async (custody) => {
      const calls: string[] = [];
      const result = await authorizeReviewer(
        { ...input, custody },
        {
          isRegisteredAgent: async () => {
            calls.push('agent');
            return false;
          },
          resolveRole: async () => {
            calls.push('role');
            return 'admin';
          },
        },
      );
      expect(result.authorized).toBe(false);
      expect(result.reason).toMatch(/custody must be device-held/);
      expect(calls).toEqual(['agent']);
    },
  );

  it('accepts only a device-held non-agent with a current admin role', async () => {
    const calls: string[] = [];
    const result = await authorizeReviewer(input, {
      isRegisteredAgent: async () => {
        calls.push('agent');
        return false;
      },
      resolveRole: async () => {
        calls.push('role');
        return 'admin';
      },
    });
    expect(result).toEqual({ authorized: true, reason: 'authorized device-held human admin' });
    expect(calls).toEqual(['agent', 'role']);
  });
});
