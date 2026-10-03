import { describe, expect, it } from 'vitest';
import {
  INSTITUTIONAL_MEMORY_BODY_MAX_BYTES,
  parseInstitutionalCuratorProposal,
  parseInstitutionalMemoryProposal,
  institutionalMemoryRequestWords,
} from './institutional-memory.js';

const workspaceFact = {
  proposalVersion: 1,
  candidateType: 'fact_candidate',
  memoryKind: 'workspace_fact',
  canonicalKey: 'deploy.release-marker-last',
  body: 'The release migration writes the schema marker last.',
  keywords: ['release', 'migration', 'marker'],
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

  it('accepts a durable fact about the requester in their profile', () => {
    expect(
      parseInstitutionalMemoryProposal({
        ...workspaceFact,
        memoryKind: 'human_profile_fact',
        subjectIdentityId: 'human-1',
        audience: 'human_profile',
        classification: {
          subjectIsRequester: true,
          rationale: 'The delivery detail is about the requester.',
        },
      }),
    ).toMatchObject({ memoryKind: 'human_profile_fact', subjectIdentityId: 'human-1' });
  });

  it('rejects a scope that contradicts the classified subject', () => {
    expect(() =>
      parseInstitutionalMemoryProposal({
        ...workspaceFact,
        classification: { ...workspaceFact.classification, subjectIsRequester: true },
      }),
    ).toThrow(/contradicts its subject/);
  });

  it('rejects widened audiences, agent-like third scopes, unknown fields, and oversized UTF-8', () => {
    expect(() =>
      parseInstitutionalMemoryProposal({
        ...workspaceFact,
        memoryKind: 'human_profile_fact',
        subjectIdentityId: 'human-1',
      }),
    ).toThrow(/audience/);
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

  it('trims bloat at save time: one terse sentence, 1 to 6 keywords, no reserved key', () => {
    const rejects = (patch: Record<string, unknown>, pattern: RegExp) =>
      expect(() => parseInstitutionalMemoryProposal({ ...workspaceFact, ...patch })).toThrow(
        pattern,
      );
    rejects({ body: 'The user prefers short replies.' }, /filler opening/);
    rejects({ body: 'Deploys run on Friday. Nobody merges after noon.' }, /one sentence/);
    rejects({ body: 'Deploys probably run on Friday.' }, /hedge/);
    rejects({ keywords: [] }, /1 to 6 keywords/);
    rejects({ keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, /1 to 6 keywords/);
    rejects({ keywords: ['the'] }, /distinctive/);
    rejects({ keywords: ['release', 'release'] }, /unique/);
    rejects({ canonicalKey: 'standing' }, /retired/);
    expect(
      parseInstitutionalMemoryProposal({ ...workspaceFact, keywords: ['Release', ' Marker '] })
        .keywords,
    ).toEqual(['release', 'marker']);
  });

  it('matches request words without stopwords', () => {
    expect([
      ...institutionalMemoryRequestWords('How do you deploy the release migration?'),
    ]).toEqual(['deploy', 'release', 'migration']);
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

  it('keeps a partition whose lifecycle action nulls the content it does not replace', () => {
    // One `"body": null` used to throw, and the throw discarded every other
    // action in the same partition proposal.
    expect(
      parseInstitutionalCuratorProposal({
        proposalVersion: 1,
        partition: 'workspace-facts',
        actions: [
          {
            action: 'stale',
            targetType: 'memory_item',
            targetId: 'item-1',
            baseVersion: 2,
            duplicateIds: [],
            body: null,
            description: null,
            markdown: null,
            rationale: 'Nothing has cited it in months.',
          },
          {
            action: 'retain',
            targetType: 'memory_item',
            targetId: 'item-2',
            baseVersion: 1,
            duplicateIds: [],
            rationale: 'Still current.',
          },
        ],
      }).actions,
    ).toEqual([
      {
        action: 'stale',
        targetType: 'memory_item',
        targetId: 'item-1',
        baseVersion: 2,
        duplicateIds: [],
        rationale: 'Nothing has cited it in months.',
      },
      {
        action: 'retain',
        targetType: 'memory_item',
        targetId: 'item-2',
        baseVersion: 1,
        duplicateIds: [],
        rationale: 'Still current.',
      },
    ]);
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
