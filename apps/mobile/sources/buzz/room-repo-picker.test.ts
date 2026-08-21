import { describe, expect, it } from 'vitest';
import {
  dedupeRepoCandidates,
  githubRepositoryLinkagePlan,
  looksLikeCornerOpenIntent,
  githubFullNameFromInput,
  roomRepoChipLabel,
} from './room-repo-picker';

const installation = {
  installationId: 7,
  accountId: '1',
  accountLogin: 'acme',
  accountType: 'Organization' as const,
  repositorySelection: 'selected' as const,
  status: 'active' as const,
  repositoryCount: 1,
  manageUrl: 'https://github.com/organizations/acme/settings/installations/7',
};

describe('githubRepositoryLinkagePlan', () => {
  it('uses an already-granted target without sending the user to a browser', () => {
    const candidate = {
      key: 'github:42',
      name: 'acme/widget',
      githubInstallationId: 7,
    };

    expect(githubRepositoryLinkagePlan('ACME/widget', [candidate], [installation])).toEqual({
      kind: 'available',
      candidate,
    });
  });

  it('uses the matching installation settings when only repository access is missing', () => {
    expect(githubRepositoryLinkagePlan('acme/widget', [], [installation])).toEqual({
      kind: 'manage',
      installation,
      fullName: 'acme/widget',
    });
  });

  it('starts installation only when the repository owner has no active installation', () => {
    expect(githubRepositoryLinkagePlan('octocat/widget', [], [installation])).toEqual({
      kind: 'install',
      owner: 'octocat',
      fullName: 'octocat/widget',
    });
  });
});

describe('dedupeRepoCandidates', () => {
  it('dedupes by key, keeping the first-seen name, sorted by name', () => {
    const result = dedupeRepoCandidates([
      { key: 'k2', name: 'zeta', remote: 'git://example.com/zeta' },
      { key: 'k1', name: 'alpha', remote: 'git://example.com/alpha' },
      { key: 'k1', name: 'alpha-dupe', remote: 'git://example.com/alpha' },
    ]);
    expect(result).toEqual([
      { key: 'k1', name: 'alpha', remote: 'git://example.com/alpha' },
      { key: 'k2', name: 'zeta', remote: 'git://example.com/zeta' },
    ]);
  });

  it('drops entries with no key', () => {
    expect(dedupeRepoCandidates([{ key: '', name: 'nope' }])).toEqual([]);
  });
});

describe('githubFullNameFromInput', () => {
  it.each([
    'acme/widget',
    'https://github.com/acme/widget',
    'https://github.com/acme/widget.git',
    'git@github.com:acme/widget.git',
    'git://github.com/acme/widget',
  ])('normalizes %s for miss-triggered install cards', (input) => {
    expect(githubFullNameFromInput(input)).toBe('acme/widget');
  });

  it('rejects non-GitHub and prose inputs', () => {
    expect(githubFullNameFromInput('https://example.com/acme/widget')).toBeNull();
    expect(githubFullNameFromInput('please use acme/widget')).toBeNull();
  });
});

describe('roomRepoChipLabel', () => {
  it('returns the binding name for a bound Room', () => {
    expect(roomRepoChipLabel({ binding: { key: 'k', name: 'widget', localOnly: false } })).toBe(
      'widget',
    );
  });

  it('returns null for a chat-only Room', () => {
    expect(roomRepoChipLabel(null)).toBeNull();
  });

  it('returns null for a blank name', () => {
    expect(roomRepoChipLabel({ binding: { key: 'k', name: '  ', localOnly: false } })).toBeNull();
  });
});

describe('looksLikeCornerOpenIntent', () => {
  it('matches common open-a-corner phrasings', () => {
    expect(looksLikeCornerOpenIntent('open a corner and fix the bug')).toBe(true);
    expect(looksLikeCornerOpenIntent('Can you open a new corner for this?')).toBe(true);
    expect(looksLikeCornerOpenIntent('start working on this in a corner')).toBe(true);
    expect(looksLikeCornerOpenIntent('CREATE CORNER')).toBe(true);
  });

  it('does not match ordinary chat', () => {
    expect(looksLikeCornerOpenIntent('what do you think about this corner case?')).toBe(false);
    expect(looksLikeCornerOpenIntent('hey, how is it going')).toBe(false);
  });
});
