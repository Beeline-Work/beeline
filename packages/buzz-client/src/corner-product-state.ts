import {
  parseChangeReviewArtifactDescriptor,
  type ChangeReviewArtifactDescriptor,
} from './change-review.js';

export const CORNER_GIT_PROJECTION_VERSION = 1 as const;
export const CORNER_GIT_PROJECTION_TAG = 'corner-git-projection';
export const CORNER_REJECTION_TAG = 'buzz-merge-rejection';

export type CornerGitRelation = 'absent' | 'no-deliverable-commits-yet' | 'review' | 'contained';
export type CornerLifecycle = 'WORKING' | 'REVIEW' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
export type CornerArchiveFlavor = 'merged' | 'rejected' | 'closed';
export type CornerHumanVerdict = 'approve' | 'reject';

/** Replaceable mechanical Git observation used only to paint RoomView. */
export type CornerGitProjection = {
  readonly version: typeof CORNER_GIT_PROJECTION_VERSION;
  readonly relation: CornerGitRelation;
  readonly repository: string;
  readonly targetBranch: string;
  readonly featureBranch: string;
  readonly featureTip?: string;
  readonly targetTip?: string;
  readonly mergeBase?: string;
  readonly artifact?: ChangeReviewArtifactDescriptor;
};

export type CornerVerdictView = {
  readonly verdict: CornerHumanVerdict;
  readonly eventId: string;
  readonly signerPubkey: string;
  readonly repository: string;
  readonly targetBranch: string;
  readonly createdAt: number;
};

export type CornerLifecycleView = {
  readonly lifecycle: CornerLifecycle;
  readonly archiveFlavor?: CornerArchiveFlavor;
  readonly git?: CornerGitProjection;
  readonly verdict?: CornerVerdictView;
};

const SHA = /^[0-9a-f]{40}$/;

export function parseCornerGitProjection(content: string): CornerGitProjection | null {
  try {
    const value = JSON.parse(content) as Partial<CornerGitProjection>;
    if (
      value.version !== CORNER_GIT_PROJECTION_VERSION ||
      (value.relation !== 'absent' &&
        value.relation !== 'no-deliverable-commits-yet' &&
        value.relation !== 'review' &&
        value.relation !== 'contained') ||
      typeof value.repository !== 'string' ||
      !value.repository ||
      typeof value.targetBranch !== 'string' ||
      !value.targetBranch ||
      typeof value.featureBranch !== 'string' ||
      !value.featureBranch ||
      (value.featureTip !== undefined && !SHA.test(value.featureTip)) ||
      (value.targetTip !== undefined && !SHA.test(value.targetTip)) ||
      (value.mergeBase !== undefined && !SHA.test(value.mergeBase))
    ) {
      return null;
    }
    const artifact =
      value.artifact === undefined
        ? undefined
        : parseChangeReviewArtifactDescriptor(JSON.stringify(value.artifact));
    if (value.artifact !== undefined && !artifact) return null;
    if (value.relation === 'review' && !value.featureTip) return null;
    if (value.relation === 'contained' && !value.featureTip) return null;
    return { ...value, ...(artifact ? { artifact } : {}) } as CornerGitProjection;
  } catch {
    return null;
  }
}

/** One-release reader for the prior artifact-only relay fact. */
export function parseCornerGitProjectionCompat(
  content: string | undefined,
): CornerGitProjection | undefined {
  if (!content) return undefined;
  const projection = parseCornerGitProjection(content);
  if (projection) return projection;
  const artifact = parseChangeReviewArtifactDescriptor(content);
  if (!artifact) return undefined;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const extended =
      value.relation === 'review' &&
      typeof value.repository === 'string' &&
      value.repository &&
      typeof value.targetBranch === 'string' &&
      value.targetBranch &&
      typeof value.featureBranch === 'string' &&
      value.featureBranch
        ? {
            repository: value.repository,
            targetBranch: value.targetBranch,
            featureBranch: value.featureBranch,
            ...(typeof value.targetTip === 'string' && SHA.test(value.targetTip)
              ? { targetTip: value.targetTip }
              : {}),
          }
        : {
            repository: 'legacy-unverified',
            targetBranch: 'legacy-unverified',
            featureBranch: 'legacy-unverified',
          };
    return {
      version: CORNER_GIT_PROJECTION_VERSION,
      relation: 'review',
      ...extended,
      featureTip: artifact.tip,
      mergeBase: artifact.base,
      artifact,
    };
  } catch {
    return undefined;
  }
}

/** Pure five-state product projector. Archive is terminal and wins first. */
export function deriveCornerLifecycle(input: {
  readonly created: boolean;
  readonly archived: boolean;
  readonly git?: CornerGitProjection;
  readonly verdict?: CornerVerdictView;
}): CornerLifecycleView {
  const facts = {
    ...(input.git ? { git: input.git } : {}),
    ...(input.verdict ? { verdict: input.verdict } : {}),
  };
  if (input.archived) {
    const archiveFlavor: CornerArchiveFlavor =
      input.git?.relation === 'contained'
        ? 'merged'
        : input.verdict?.verdict === 'reject'
          ? 'rejected'
          : 'closed';
    return { lifecycle: 'ARCHIVED', archiveFlavor, ...facts };
  }
  if (input.verdict?.verdict === 'reject') return { lifecycle: 'REJECTED', ...facts };
  if (
    input.verdict?.verdict === 'approve' &&
    (input.git?.relation === 'review' || input.git?.relation === 'contained')
  ) {
    return { lifecycle: 'APPROVED', ...facts };
  }
  if (input.git?.relation === 'review') return { lifecycle: 'REVIEW', ...facts };
  return { lifecycle: 'WORKING', ...facts };
}
