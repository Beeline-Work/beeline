import { describe, expect, it } from 'vitest';
import { encodeNpub } from '@beeline/nostr';
import {
  namedRepositoryTargetFromPermission,
  namedRepositoryTargetFromRoomRequest,
  parseNamedRepositoryTarget,
} from './repository-target.js';

describe('named repository targets', () => {
  it('parses GitHub and relay owner/repo identities without changing the approved display id', () => {
    expect(parseNamedRepositoryTarget('lunchboxfortwo/buzzy')).toEqual({
      id: 'lunchboxfortwo/buzzy',
      owner: 'lunchboxfortwo',
      repo: 'buzzy',
      kind: 'github',
    });

    const ownerHex = 'ab'.repeat(32);
    const owner = encodeNpub(ownerHex);
    expect(parseNamedRepositoryTarget(`${owner}/private-repo`)).toEqual({
      id: `${owner}/private-repo`,
      owner,
      repo: 'private-repo',
      kind: 'relay',
      relayOwnerHex: ownerHex,
    });
  });

  it('requires the explicit host marker and never infers a target from unrelated tool input', () => {
    expect(
      namedRepositoryTargetFromPermission({
        toolCall: {
          kind: 'execute',
          title: 'Run shell',
          rawInput: {
            command: 'beeline-request-edit-corner --repo lunchboxfortwo/buzzy',
          },
        },
      }),
    ).toMatchObject({ id: 'lunchboxfortwo/buzzy', kind: 'github' });
    expect(
      namedRepositoryTargetFromPermission({
        toolCall: {
          kind: 'edit',
          title: 'Edit lunchboxfortwo/buzzy README',
          rawInput: { repository: 'lunchboxfortwo/buzzy' },
        },
      }),
    ).toBeUndefined();
  });

  it('rejects clone URLs, missing owners, and ambiguous extra path segments', () => {
    for (const value of [
      'https://github.com/lunchboxfortwo/buzzy',
      'buzzy',
      'owner/repo/extra',
      'owner/repo.git',
    ]) {
      expect(() => parseNamedRepositoryTarget(value)).toThrow();
    }
  });

  it('reads only explicitly labelled repository targets from Room prose', () => {
    expect(
      namedRepositoryTargetFromRoomRequest(
        'In repository lunchboxfortwo/buzzy, append a line to README.md.',
      ),
    ).toMatchObject({ id: 'lunchboxfortwo/buzzy', kind: 'github' });
    expect(
      namedRepositoryTargetFromRoomRequest(
        'beeline-request-edit-corner --repo lunchboxfortwo/buzzy',
      ),
    ).toMatchObject({ id: 'lunchboxfortwo/buzzy' });
    expect(
      namedRepositoryTargetFromRoomRequest('Edit src/index.ts and docs/README.md.'),
    ).toBeUndefined();
  });
});
