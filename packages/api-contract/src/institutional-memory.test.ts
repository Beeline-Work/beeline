import { describe, expect, it } from 'vitest';
import {
  INSTITUTIONAL_MEMORY_BODY_MAX_BYTES,
  parseInstitutionalCuratorProposal,
  parseInstitutionalMergeReviewProposal,
  parseInstitutionalMemoryProposal,
} from './institutional-memory.js';

const workspaceFact = {
  proposalVersion: 1,
  candidateType: 'fact_candidate',
  memoryKind: 'workspace_fact',
  canonicalKey: 'deploy.release-marker-last',
  body: 'The release migration writes the schema marker last.',
  source: { roomId: 'room-1', messageIds: ['message-1'] },
  audience: 'workspace',
  confidence: 0.96,
  classification: {
    stillTrueForAnotherRequester: true,
    rationale: 'The deploy ordering does not depend on who asks.',
  },
  cas: { baseVersion: null },
} as const;

describe('institutional memory proposal contract', () => {
  it('accepts a bounded workspace fact with source and CAS fields', () => {
    expect(parseInstitutionalMemoryProposal(workspaceFact)).toEqual(workspaceFact);
  });

  it('accepts a correction classified as one human workflow preference', () => {
    expect(
      parseInstitutionalMemoryProposal({
        ...workspaceFact,
        candidateType: 'correction_candidate',
        memoryKind: 'human_profile_fact',
        subjectIdentityId: 'human-1',
        audience: 'human_profile',
        classification: {
          stillTrueForAnotherRequester: false,
          rationale: 'Only this requester asked for a mock before implementation.',
        },
      }),
    ).toMatchObject({ memoryKind: 'human_profile_fact', subjectIdentityId: 'human-1' });
  });

  it('accepts a stated working preference without misclassifying it as a correction', () => {
    expect(
      parseInstitutionalMemoryProposal({
        ...workspaceFact,
        candidateType: 'preference_candidate',
        memoryKind: 'human_profile_fact',
        subjectIdentityId: 'human-1',
        audience: 'human_profile',
        classification: {
          stillTrueForAnotherRequester: false,
          rationale: 'This is how this requester likes progress updates formatted.',
        },
      }),
    ).toMatchObject({
      candidateType: 'preference_candidate',
      memoryKind: 'human_profile_fact',
      subjectIdentityId: 'human-1',
    });
  });

  it('rejects widened audiences, agent-like third scopes, unknown fields, and oversized UTF-8', () => {
    expect(() =>
      parseInstitutionalMemoryProposal({
        ...workspaceFact,
        memoryKind: 'human_profile_fact',
        subjectIdentityId: 'human-1',
      }),
    ).toThrow(/requester test/);
    expect(() =>
      parseInstitutionalMemoryProposal({ ...workspaceFact, audience: 'source_room' }),
    ).toThrow(/audience/);
    expect(() =>
      parseInstitutionalMemoryProposal({ ...workspaceFact, agentId: 'agent-1' }),
    ).toThrow(/unknown field agentId/);
    expect(() =>
      parseInstitutionalMemoryProposal({
        ...workspaceFact,
        body: '🐝'.repeat(INSTITUTIONAL_MEMORY_BODY_MAX_BYTES / 2 + 1),
      }),
    ).toThrow(/body/);
  });
});

describe('institutional merge review contract', () => {
  const proposal = {
    proposalVersion: 1,
    skill: {
      slug: 'release-migrations',
      description: 'Safely ship release-owned database changes',
      markdown: '# Release migrations\n\nWrite the schema marker last.',
      baseVersion: null,
      anchor: { repository: 'Beeline-Work/beeline', targetCommit: 'a'.repeat(40) },
    },
    findings: [
      {
        taxonomy: 'database.release-order',
        summary: 'Schema readiness must be marked only after every migration succeeds.',
        severity: 'warning',
        confidence: 0.98,
        path: 'apps/server/src/database.ts',
      },
    ],
  } as const;

  it('accepts one bounded restricted procedure and structured findings', () => {
    expect(parseInstitutionalMergeReviewProposal(proposal)).toEqual(proposal);
  });

  it('rejects unknown fields, invalid slugs, and descriptions over 60 characters', () => {
    expect(() => parseInstitutionalMergeReviewProposal({ ...proposal, native: true })).toThrow(
      /unknown field native/,
    );
    expect(() =>
      parseInstitutionalMergeReviewProposal({
        ...proposal,
        skill: { ...proposal.skill, slug: 'Native Skill' },
      }),
    ).toThrow(/slug/);
    expect(() =>
      parseInstitutionalMergeReviewProposal({
        ...proposal,
        skill: { ...proposal.skill, description: 'x'.repeat(61) },
      }),
    ).toThrow(/description/);
  });
});

describe('institutional curator contract', () => {
  it('accepts bounded in-partition lifecycle and consolidation actions', () => {
    expect(
      parseInstitutionalCuratorProposal({
        proposalVersion: 1,
        partition: 'workspace-facts',
        actions: [
          {
            action: 'consolidate',
            targetType: 'memory_item',
            targetId: 'item-1',
            baseVersion: 2,
            duplicateIds: ['item-2'],
            body: 'Release migrations write their schema marker last.',
            rationale: 'Both facts describe the same invariant.',
          },
          {
            action: 'retain',
            targetType: 'memory_item',
            targetId: 'item-3',
            baseVersion: 1,
            duplicateIds: [],
            rationale: 'It is recent and distinct.',
          },
        ],
      }),
    ).toMatchObject({
      partition: 'workspace-facts',
      actions: expect.arrayContaining([expect.objectContaining({ action: 'consolidate' })]),
    });
  });

  it('rejects consolidation without duplicates and lifecycle actions with replacement text', () => {
    expect(() =>
      parseInstitutionalCuratorProposal({
        proposalVersion: 1,
        partition: 'workspace-facts',
        actions: [
          {
            action: 'consolidate',
            targetType: 'memory_item',
            targetId: 'item-1',
            baseVersion: 1,
            duplicateIds: [],
            body: 'Body',
            rationale: 'No duplicate.',
          },
        ],
      }),
    ).toThrow(/needs duplicates/);
    expect(() =>
      parseInstitutionalCuratorProposal({
        proposalVersion: 1,
        partition: 'workspace-facts',
        actions: [
          {
            action: 'stale',
            targetType: 'memory_item',
            targetId: 'item-1',
            baseVersion: 1,
            duplicateIds: [],
            body: 'Replacement',
            rationale: 'Invalid replacement.',
          },
        ],
      }),
    ).toThrow(/cannot replace content/);
  });
});
