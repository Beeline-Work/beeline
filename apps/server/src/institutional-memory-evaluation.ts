import {
  parseInstitutionalMemoryProposal,
  type InstitutionalMemoryCandidateType,
  type InstitutionalMemoryKind,
  type InstitutionalMemoryProposal,
} from '@beeline/api-contract/daemon';

export interface InstitutionalMemoryAuditLabel {
  readonly candidateType: InstitutionalMemoryCandidateType;
  readonly memoryKind: InstitutionalMemoryKind;
  readonly canonicalKey: string;
}

/** Portable fixture/export row: production shadow output plus an optional audit label. */
export interface InstitutionalMemoryAuditRecord {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly requesterIdentityId: string;
  readonly eligibleTurnOrdinal: number;
  readonly expected: InstitutionalMemoryAuditLabel | null;
  readonly actual: unknown;
  readonly inputBytes?: number;
  readonly outputBytes?: number;
  readonly estimatedCostUsdMicros?: number;
}

export interface InstitutionalMemoryShadowMetrics {
  readonly records: number;
  readonly proposed: number;
  readonly invalid: number;
  readonly exactTruePositives: number;
  readonly precision: number | null;
  readonly correctionProposed: number;
  readonly correctionExactTruePositives: number;
  readonly correctionPrecision: number | null;
  readonly repeatCorrectionEligible: number;
  readonly repeatCorrections: number;
  readonly repeatCorrectionRate: number | null;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly estimatedCostUsdMicros: number;
}

function matchesLabel(
  proposal: InstitutionalMemoryProposal,
  expected: InstitutionalMemoryAuditLabel | null,
): boolean {
  return Boolean(
    expected &&
    proposal.candidateType === expected.candidateType &&
    proposal.memoryKind === expected.memoryKind &&
    proposal.canonicalKey === expected.canonicalKey,
  );
}

function nonnegative(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}

/**
 * Compute the Phase-0 baseline without a model or database connection.
 * Repeat correction uses the next 20 eligible turns for the same human in
 * the same Workspace, exactly matching the product objective denominator.
 */
export function computeInstitutionalMemoryShadowMetrics(
  records: readonly InstitutionalMemoryAuditRecord[],
): InstitutionalMemoryShadowMetrics {
  const valid = new Map<string, InstitutionalMemoryProposal | null>();
  let proposed = 0;
  let invalid = 0;
  let exactTruePositives = 0;
  let correctionProposed = 0;
  let correctionExactTruePositives = 0;

  for (const record of records) {
    if (record.actual === null) {
      valid.set(record.jobId, null);
      continue;
    }
    try {
      const proposal = parseInstitutionalMemoryProposal(record.actual);
      valid.set(record.jobId, proposal);
      proposed += 1;
      if (matchesLabel(proposal, record.expected)) exactTruePositives += 1;
      if (proposal.candidateType === 'correction_candidate') {
        correctionProposed += 1;
        if (matchesLabel(proposal, record.expected)) correctionExactTruePositives += 1;
      }
    } catch {
      invalid += 1;
    }
  }

  let repeatCorrectionEligible = 0;
  let repeatCorrections = 0;
  const cohorts = new Map<string, InstitutionalMemoryAuditRecord[]>();
  for (const record of records) {
    const key = `${record.workspaceId}\0${record.requesterIdentityId}`;
    const cohort = cohorts.get(key) ?? [];
    cohort.push(record);
    cohorts.set(key, cohort);
  }
  for (const cohort of cohorts.values()) {
    cohort.sort((left, right) => left.eligibleTurnOrdinal - right.eligibleTurnOrdinal);
    for (let index = 0; index < cohort.length; index += 1) {
      const current = valid.get(cohort[index]!.jobId);
      if (!current || current.candidateType !== 'correction_candidate') continue;
      const following = cohort.slice(index + 1, index + 21);
      if (following.length < 20) continue;
      repeatCorrectionEligible += 1;
      if (
        following.some((record) => {
          const candidate = valid.get(record.jobId);
          return (
            candidate?.candidateType === 'correction_candidate' &&
            candidate.canonicalKey === current.canonicalKey
          );
        })
      ) {
        repeatCorrections += 1;
      }
    }
  }

  return {
    records: records.length,
    proposed,
    invalid,
    exactTruePositives,
    precision: proposed ? exactTruePositives / proposed : null,
    correctionProposed,
    correctionExactTruePositives,
    correctionPrecision: correctionProposed
      ? correctionExactTruePositives / correctionProposed
      : null,
    repeatCorrectionEligible,
    repeatCorrections,
    repeatCorrectionRate: repeatCorrectionEligible
      ? repeatCorrections / repeatCorrectionEligible
      : null,
    inputBytes: records.reduce((sum, record) => sum + nonnegative(record.inputBytes), 0),
    outputBytes: records.reduce((sum, record) => sum + nonnegative(record.outputBytes), 0),
    estimatedCostUsdMicros: records.reduce(
      (sum, record) => sum + nonnegative(record.estimatedCostUsdMicros),
      0,
    ),
  };
}
