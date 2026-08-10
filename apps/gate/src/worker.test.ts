import { describe, expect, it } from 'vitest';
import { signEvent } from '@beeline/nostr';
import { newIdentity } from './identity.js';
import { roomMergeCandidates } from './worker.js';

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
