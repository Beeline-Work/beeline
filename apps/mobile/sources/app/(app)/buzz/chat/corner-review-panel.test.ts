import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cornerReviewPanelMountState,
  mergeTargetFromCornerLifecycle,
} from '@/buzz/corner-attention';

const chatSource = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');
const CORNER_ID = '9958a1da-18b6-453b-9c04-b5aee03e5d36';
const TIP = 'a'.repeat(40);
const PATCH_ID = 'b'.repeat(40);
const files = Array.from({ length: 12 }, (_, index) => ({
  path: `apps/mobile/sources/review-${index + 1}.ts`,
  status: 'modified' as const,
}));
const artifact = {
  version: 2 as const,
  base: 'c'.repeat(40),
  tip: TIP,
  patchId: PATCH_ID,
  summary: 'Restore the corner review panel.',
  fileCount: files.length,
  files,
  url: 'https://example.test/review.json',
  sha256: 'd'.repeat(64),
  size: 1024,
};
const lifecycle = {
  lifecycle: 'REVIEW',
  git: {
    version: 1,
    relation: 'review',
    repository: 'lunchboxfortwo/beeline',
    targetBranch: 'refs/heads/main',
    featureBranch: 'fm/corner-review-panel-gate',
    featureTip: TIP,
    artifact,
  },
} as const;

const productionShape = {
  room: {
    id: CORNER_ID,
    workspaceId: 'workspace',
    parentId: 'parent-room',
    name: 'Corner review panel gate',
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  parent: {
    id: 'parent-room',
    workspaceId: 'workspace',
    name: 'Buzzy',
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  messages: [],
  members: [],
  latestAgentTurns: [],
  viewer: {
    identity: { pubkey: 'owner', kind: 'human', name: 'Owner' },
    role: 'owner',
    permissions: { send: true, manage: true },
  },
  repository: {
    key: 'lunchboxfortwo/beeline',
    name: 'beeline',
    remote: 'git://github.com/lunchboxfortwo/beeline',
    targetBranch: 'main',
    updatedAt: 1,
    githubEventsEnabled: false,
  },
  repositoryResolution: 'repository',
  review: { status: 'ready', artifact, files, approvedBy: [] },
  cornerLifecycle: lifecycle,
  corners: [
    {
      corner: {
        id: CORNER_ID,
        workspaceId: 'workspace',
        parentId: 'parent-room',
        name: 'Corner review panel gate',
        archived: false,
        createdAt: 1,
        updatedAt: 2,
      },
      lifecycle,
      status: 'waiting',
      reason: 'review',
    },
  ],
  watchFilters: [{ '#h': [CORNER_ID] }],
};

describe('corner review panel mount truth', () => {
  it('keeps the approve affordance mounted for REVIEW while corner narration says waiting', () => {
    const target = mergeTargetFromCornerLifecycle(productionShape.cornerLifecycle);
    const listStatus = productionShape.corners[0]?.status;
    const sessionFinished = listStatus === 'concluded' || listStatus === 'closed';

    expect(listStatus).toBe('waiting');
    expect(sessionFinished).toBe(false);
    expect(productionShape.repository).toBeDefined();
    expect(productionShape.review?.artifact).toBe(artifact);
    expect(productionShape.review?.files).toHaveLength(12);
    expect(target).toEqual({
      repo: 'lunchboxfortwo/beeline',
      branch: 'refs/heads/main',
      tip: TIP,
      patchId: PATCH_ID,
    });
    expect(
      cornerReviewPanelMountState({
        isCorner: true,
        archived: false,
        mergeTarget: target,
        sessionFinished,
      }),
    ).toBe('review');

    const header = chatSource.slice(
      chatSource.indexOf('ListHeaderComponent='),
      chatSource.indexOf('\n        />', chatSource.indexOf('ListHeaderComponent=')),
    );
    expect(header).toContain('reviewPanelMountState ?');
    expect(header).toContain('testID="approve-corner"');
    expect(header).not.toContain("sessionState === 'done'");
  });
});
