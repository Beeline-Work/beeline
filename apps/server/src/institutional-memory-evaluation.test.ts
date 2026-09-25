import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstitutionalMemoryProposal } from '@beeline/api-contract/daemon';
import {
  computeInstitutionalMemoryShadowMetrics,
  type InstitutionalMemoryAuditRecord,
} from './institutional-memory-evaluation.js';

const correction = (canonicalKey: string): InstitutionalMemoryProposal => ({
  proposalVersion: 1,
  candidateType: 'correction_candidate',
  memoryKind: 'human_profile_fact',
  subjectIdentityId: 'human-1',
  canonicalKey,
  body: 'The requester prefers this workflow.',
  source: { roomId: 'room-1', messageIds: ['message-1'] },
  audience: 'human_profile',
  confidence: 0.9,
  classification: { stillTrueForAnotherRequester: false, rationale: 'Personal workflow.' },
  cas: { baseVersion: null },
});

describe('institutional memory shadow evaluation', () => {
  it('computes precision and byte/cost plumbing from an offline fixture', async () => {
    const records = JSON.parse(
      await readFile(resolve('src/fixtures/institutional-memory-shadow-evaluation.json'), 'utf8'),
    ) as InstitutionalMemoryAuditRecord[];
    expect(computeInstitutionalMemoryShadowMetrics(records)).toMatchObject({
      records: 4,
      proposed: 3,
      invalid: 0,
      exactTruePositives: 2,
      precision: 2 / 3,
      correctionProposed: 1,
      correctionPrecision: 1,
      inputBytes: 3280,
      outputBytes: 1144,
      estimatedCostUsdMicros: 67,
    });
  });

  it('uses exactly the next twenty eligible turns for repeat-correction baseline', () => {
    const records: InstitutionalMemoryAuditRecord[] = Array.from({ length: 22 }, (_, index) => ({
      jobId: `job-${index + 1}`,
      workspaceId: 'workspace-1',
      requesterIdentityId: 'human-1',
      eligibleTurnOrdinal: index + 1,
      expected: null,
      actual:
        index === 0 || index === 1
          ? correction(index === 0 ? 'same-correction' : 'same-correction')
          : null,
    }));
    expect(computeInstitutionalMemoryShadowMetrics(records)).toMatchObject({
      repeatCorrectionEligible: 2,
      repeatCorrections: 1,
      repeatCorrectionRate: 0.5,
    });
  });

  it('counts malformed shadow output without throwing', () => {
    const metrics = computeInstitutionalMemoryShadowMetrics([
      {
        jobId: 'bad',
        workspaceId: 'workspace-1',
        requesterIdentityId: 'human-1',
        eligibleTurnOrdinal: 1,
        expected: null,
        actual: { proposalVersion: 99 },
      },
    ]);
    expect(metrics).toMatchObject({ records: 1, proposed: 0, invalid: 1, precision: null });
  });
});
