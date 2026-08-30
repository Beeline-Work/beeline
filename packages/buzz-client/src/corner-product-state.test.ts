import { describe, expect, it } from 'vitest';
import {
  deriveCornerLifecycle,
  parseCornerGitProjection,
  type CornerGitProjection,
  type CornerVerdictView,
} from './corner-product-state.js';

const git = (relation: CornerGitProjection['relation']): CornerGitProjection => ({
  version: 1,
  relation,
  repository: 'owner/repo',
  targetBranch: 'refs/heads/main',
  featureBranch: 'fm/change',
  ...(relation === 'review' || relation === 'contained' ? { featureTip: 'a'.repeat(40) } : {}),
  ...(relation === 'review'
    ? {
        artifact: {
          version: 2,
          base: 'b'.repeat(40),
          tip: 'a'.repeat(40),
          patchId: 'c'.repeat(40),
          summary: 'Change',
          fileCount: 1,
          files: [{ path: 'a.ts', status: 'modified' }],
          url: 'https://example.test/review.json',
          sha256: 'd'.repeat(64),
          size: 10,
        },
      }
    : {}),
});

const verdict = (value: CornerVerdictView['verdict']): CornerVerdictView => ({
  verdict: value,
  eventId: 'e'.repeat(64),
  signerPubkey: 'f'.repeat(64),
  repository: 'owner/repo',
  targetBranch: 'refs/heads/main',
  createdAt: 1,
});

describe('corner five-state projector', () => {
  it.each([
    [{ created: true, archived: false }, 'WORKING'],
    [{ created: true, archived: false, git: git('review') }, 'REVIEW'],
    [
      { created: true, archived: false, git: git('review'), verdict: verdict('approve') },
      'APPROVED',
    ],
    [
      { created: true, archived: false, git: git('review'), verdict: verdict('reject') },
      'REJECTED',
    ],
  ] as const)('derives %s as %s', (input, lifecycle) => {
    expect(deriveCornerLifecycle(input).lifecycle).toBe(lifecycle);
  });

  it('3. list close invalidation makes archived terminal with only derived flavors', () => {
    expect(
      deriveCornerLifecycle({ created: true, archived: true, git: git('contained') }),
    ).toMatchObject({
      lifecycle: 'ARCHIVED',
      archiveFlavor: 'merged',
    });
    expect(
      deriveCornerLifecycle({
        created: true,
        archived: true,
        git: git('review'),
        verdict: verdict('reject'),
      }),
    ).toMatchObject({ lifecycle: 'ARCHIVED', archiveFlavor: 'rejected' });
    expect(deriveCornerLifecycle({ created: true, archived: true })).toMatchObject({
      lifecycle: 'ARCHIVED',
      archiveFlavor: 'closed',
    });
  });

  it('keeps REVIEW mechanical when its optional artifact is temporarily unavailable', () => {
    expect(
      parseCornerGitProjection(JSON.stringify({ ...git('review'), artifact: undefined })),
    ).toMatchObject({ relation: 'review', featureTip: 'a'.repeat(40) });
  });

  it('2. hidden transcript cards cannot hide an approval from the lifecycle DTO', () => {
    const projected = deriveCornerLifecycle({
      created: true,
      archived: false,
      git: git('review'),
      verdict: verdict('approve'),
    });
    expect(projected.lifecycle).toBe('APPROVED');
    expect(Object.keys(projected)).not.toContain('presentation');
  });

  it('rejection archives without changing the recoverable feature branch', () => {
    const projected = deriveCornerLifecycle({
      created: true,
      archived: true,
      git: git('review'),
      verdict: verdict('reject'),
    });
    expect(projected).toMatchObject({
      lifecycle: 'ARCHIVED',
      archiveFlavor: 'rejected',
      git: { featureBranch: 'fm/change' },
    });
  });
});
