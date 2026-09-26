import { describe, expect, it } from 'vitest';
import {
  INSTITUTIONAL_MEMORY_BODY_MAX_BYTES,
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
