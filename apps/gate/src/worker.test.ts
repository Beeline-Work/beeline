import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signEvent } from '@beeline/nostr';
import { newIdentity } from './identity.js';
import {
  authorizeReviewer,
  roomMergeCandidates,
  withFreshClone,
  type MergeRequest,
} from './worker.js';

describe('merge attempt clone lifetime', () => {
  const request = {
    worker: newIdentity('worker'),
    trustedReviewer: 'a'.repeat(64),
    trustedReviewerCustody: 'device',
    repo: 'project',
    channelId: '11111111-1111-4111-8111-111111111111',
    targetBranch: 'main',
    featureBranch: 'feature/change',
  } satisfies MergeRequest;

  it.each([
    { merged: false, reason: 'refused' },
    { merged: true, reason: 'merged' },
  ])('removes the fresh clone after a $reason outcome', async (outcome) => {
    let root = '';
    const result = await withFreshClone(
      request,
      async (work) => {
        writeFileSync(join(work, 'marker'), 'used');
        return outcome;
      },
      async (temporaryRoot) => {
        root = temporaryRoot;
        const work = join(root, 'work');
        mkdirSync(work);
        return work;
      },
    );

    expect(result).toEqual(outcome);
    expect(root).not.toBe('');
    expect(existsSync(root)).toBe(false);
  });

  it('removes the temporary root when cloning fails', async () => {
    let root = '';
    await expect(
      withFreshClone(
        request,
        async () => ({ merged: false, reason: 'unreachable' }),
        async (temporaryRoot) => {
          root = temporaryRoot;
          throw new Error('clone failed');
        },
      ),
    ).rejects.toThrow('clone failed');
    expect(existsSync(root)).toBe(false);
  });
});

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
    relay: { queryEvents: async () => [] },
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
    expect(result.terminal).toBe(true);
    expect(calls).toEqual(['agent']);
  });

  it('fails closed on agent-registry outage without consulting roles, but leaves it retryable', async () => {
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
    // A relay/registry outage is transient — it must not be classified the
    // same as a genuine authorization refusal, or DurableMergeGate would give
    // up retrying an approval that was never actually rejected.
    expect(result.terminal).toBe(false);
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
      expect(result.terminal).toBe(true);
      expect(calls).toEqual(['agent']);
    },
  );

  it('refuses a non-admin signer role, terminally', async () => {
    const result = await authorizeReviewer(input, {
      isRegisteredAgent: async () => false,
      resolveRole: async () => 'member',
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/human admin role required/);
    expect(result.terminal).toBe(true);
  });

  it('fails closed on a role-lookup outage, but leaves it retryable', async () => {
    const result = await authorizeReviewer(input, {
      isRegisteredAgent: async () => false,
      resolveRole: async () => {
        throw new Error('relay unreachable');
      },
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/role lookup failed/);
    expect(result.terminal).toBe(false);
  });

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
    expect(result).toEqual({
      authorized: true,
      terminal: false,
      reason: 'authorized device-held human admin',
    });
    expect(calls).toEqual(['agent', 'role']);
  });
});
