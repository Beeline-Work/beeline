/** Institutional-memory extraction, storage, and bounded prompt contract. */
export const INSTITUTIONAL_MEMORY_PROPOSAL_VERSION = 1 as const;
export const INSTITUTIONAL_MEMORY_BODY_MAX_BYTES = 4_000;
export const INSTITUTIONAL_MEMORY_CANONICAL_KEY_MAX_LENGTH = 160;
export const INSTITUTIONAL_MEMORY_RATIONALE_MAX_LENGTH = 500;
export const INSTITUTIONAL_MEMORY_SOURCE_MESSAGE_MAX = 16;
export const INSTITUTIONAL_MEMORY_EXTRACTOR_VERSION_MAX_LENGTH = 120;
export const INSTITUTIONAL_MEMORY_MODEL_MAX_LENGTH = 160;
export const INSTITUTIONAL_MEMORY_JOB_ERROR_MAX_LENGTH = 1_000;
export const INSTITUTIONAL_CONTEXT_HARD_MAX_BYTES = 8_000;
export const INSTITUTIONAL_CONTEXT_WORKSPACE_MAX_BYTES = 2_500;
export const INSTITUTIONAL_CONTEXT_PROFILE_MAX_BYTES = 3_000;
export const INSTITUTIONAL_CONTEXT_WRAPPER_MAX_BYTES = 700;
export const INSTITUTIONAL_HISTORY_QUERY_MAX_BYTES = 500;
export const INSTITUTIONAL_HISTORY_RESULT_MAX = 10;
export const INSTITUTIONAL_HISTORY_SNIPPET_MAX_BYTES = 360;

export type InstitutionalMemoryCandidateType =
  'correction_candidate' | 'fact_candidate' | 'preference_candidate';
export type InstitutionalMemoryKind = 'workspace_fact' | 'human_profile_fact';
export type InstitutionalMemoryAudience = 'workspace' | 'human_profile';
export type InstitutionalMemoryItemState = 'active' | 'stale' | 'archived';
export type InstitutionalMemoryJobState = 'pending' | 'claimed' | 'retry' | 'completed' | 'dead';

export interface InstitutionalMemoryJobLedgerEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly triggerKind: 'turn_review' | 'merge_review' | 'curator';
  readonly mode: 'shadow' | 'live';
  readonly sourceRoomId: string;
  readonly sourceMessageId: string;
  readonly sourceRequestId?: string;
  readonly requesterIdentityId: string;
  readonly sourceAudienceKind: 'workspace_candidate' | 'human_private';
  readonly idempotencyKey: string;
  readonly status: InstitutionalMemoryJobState;
  /** Processing attribution only; never memory ownership or visibility. */
  readonly leaseOwnerAgentId?: string;
  readonly leaseOwnerMachineId?: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly proposal?: InstitutionalMemoryProposal | null;
  readonly usage?: InstitutionalMemoryJobUsage;
  readonly error?: string;
}

/** Server-owned sourced item. Processing agent ids are attribution, never scope. */
export interface InstitutionalMemoryItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: InstitutionalMemoryKind;
  readonly subjectIdentityId?: string;
  readonly canonicalKey: string;
  readonly body: string;
  readonly state: InstitutionalMemoryItemState;
  readonly sourceRoomId: string;
  readonly sourceMessageId: string;
  readonly sourceCornerId?: string;
  readonly audience: InstitutionalMemoryAudience;
  readonly confidence: number;
  readonly version: number;
  readonly supersedesItemId?: string;
  readonly createdByJobId?: string;
  readonly createdByCommandId?: string;
  readonly deletedAt?: number;
}

/** One immutable measurement row. Shadow rows must have served=false and zero bytes. */
export interface InstitutionalContextServeLedgerEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId?: string;
  readonly requesterIdentityId: string;
  readonly snapshotRevision: number;
  readonly mode: 'shadow' | 'live';
  readonly served: boolean;
  readonly shadowJobId?: string;
  readonly itemIds: readonly string[];
  readonly skillCandidates: readonly string[];
  readonly workspaceFactBytes: number;
  readonly profileBytes: number;
  readonly skillIndexBytes: number;
  readonly wrapperBytes: number;
  readonly totalBytes: number;
  readonly estimatedTokens: number;
  readonly actualTokens?: number;
  readonly candidateCount: number;
  readonly droppedCounts: Readonly<Record<string, number>>;
}

export interface InstitutionalMemoryOutcomeLedgerEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly serveId?: string;
  readonly jobId?: string;
  readonly roomId: string;
  readonly requestId?: string;
  readonly kind: string;
  readonly success?: boolean;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface InstitutionalMemoryProposalSource {
  readonly roomId: string;
  readonly messageIds: readonly string[];
}

export interface InstitutionalMemoryProposalCas {
  /** Null means the extractor found no current item to compare against. */
  readonly baseVersion: number | null;
  readonly supersedesItemId?: string;
}

export interface InstitutionalMemoryProposal {
  readonly proposalVersion: typeof INSTITUTIONAL_MEMORY_PROPOSAL_VERSION;
  readonly candidateType: InstitutionalMemoryCandidateType;
  readonly memoryKind: InstitutionalMemoryKind;
  /** Human profile subject. Workspace facts never carry one. */
  readonly subjectIdentityId?: string;
  readonly canonicalKey: string;
  readonly body: string;
  readonly source: InstitutionalMemoryProposalSource;
  readonly audience: InstitutionalMemoryAudience;
  readonly confidence: number;
  readonly classification: {
    /** The captain's one classification test. */
    readonly stillTrueForAnotherRequester: boolean;
    readonly rationale: string;
  };
  readonly cas: InstitutionalMemoryProposalCas;
}

export interface InstitutionalMemoryJobUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCostUsdMicros?: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly model: string;
  readonly extractorVersion: string;
}

export interface InstitutionalMemoryShadowMessage {
  readonly id: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly text: string;
}

export interface InstitutionalMemoryShadowJob {
  readonly id: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
  readonly workspaceId: string;
  readonly sourceRoomId: string;
  readonly sourceMessageId: string;
  readonly requesterIdentityId: string;
  readonly directMessage: boolean;
  readonly mode: 'shadow' | 'live';
  readonly messages: readonly InstitutionalMemoryShadowMessage[];
  readonly existingItems: readonly Pick<
    InstitutionalMemoryItem,
    'id' | 'kind' | 'subjectIdentityId' | 'canonicalKey' | 'body' | 'version'
  >[];
}

export type ClaimInstitutionalMemoryJobResult =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly job?: InstitutionalMemoryShadowJob };

export interface CompleteInstitutionalMemoryJobInput {
  readonly agentId: string;
  readonly jobId: string;
  readonly leaseToken: string;
  /** Null is a valid shadow verdict: the source contained no durable lesson. */
  readonly proposal: InstitutionalMemoryProposal | null;
  readonly usage: InstitutionalMemoryJobUsage;
}

export interface FailInstitutionalMemoryJobInput {
  readonly agentId: string;
  readonly jobId: string;
  readonly leaseToken: string;
  readonly error: string;
  readonly retryable: boolean;
}

export interface InstitutionalContextSnapshot {
  readonly snapshotRevision: number;
  /** Empty means memory was unavailable or nothing was relevant. */
  readonly text: string;
  readonly itemIds: readonly string[];
  readonly totalBytes: number;
  readonly omitted: Readonly<Record<string, number>>;
}

export interface ProposeInstitutionalMemoryInput {
  readonly agentId: string;
  readonly roomId: string;
  readonly requestId?: string;
  readonly generationId?: string;
  readonly memoryKind: InstitutionalMemoryKind;
  readonly canonicalKey: string;
  readonly body: string;
  readonly sourceMessageIds: readonly string[];
  readonly correction: boolean;
  readonly confidence: number;
  readonly cas: InstitutionalMemoryProposalCas;
}

export interface ProposeInstitutionalMemoryResult {
  readonly itemId: string;
  readonly version: number;
}

export interface SearchInstitutionalHistoryInput {
  readonly agentId: string;
  readonly roomId: string;
  readonly requestId?: string;
  readonly generationId?: string;
  readonly query: string;
  readonly limit?: number;
}

export interface InstitutionalHistoryResult {
  readonly messageId: string;
  readonly roomId: string;
  readonly roomName: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly snippet: string;
  readonly rank: number;
}

export interface SearchInstitutionalHistoryResult {
  readonly results: readonly InstitutionalHistoryResult[];
  readonly omitted: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`);
}

function boundedText(value: unknown, label: string, maximum: number, bytes = false): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  const size = bytes ? new TextEncoder().encode(normalized).length : normalized.length;
  if (!normalized || size > maximum) throw new Error(`${label} is invalid`);
  return normalized;
}

/**
 * Strict parser shared by the server boundary and offline fixtures. Unknown
 * fields fail closed so a newer extractor cannot silently bypass an older
 * server's provenance or classification rules.
 */
export function parseInstitutionalMemoryProposal(value: unknown): InstitutionalMemoryProposal {
  const proposal = record(value, 'institutional memory proposal');
  exactKeys(
    proposal,
    [
      'proposalVersion',
      'candidateType',
      'memoryKind',
      'subjectIdentityId',
      'canonicalKey',
      'body',
      'source',
      'audience',
      'confidence',
      'classification',
      'cas',
    ],
    'institutional memory proposal',
  );
  if (proposal.proposalVersion !== INSTITUTIONAL_MEMORY_PROPOSAL_VERSION) {
    throw new Error('institutional memory proposal version is unsupported');
  }
  if (
    proposal.candidateType !== 'correction_candidate' &&
    proposal.candidateType !== 'fact_candidate' &&
    proposal.candidateType !== 'preference_candidate'
  ) {
    throw new Error('institutional memory candidate type is invalid');
  }
  if (proposal.memoryKind !== 'workspace_fact' && proposal.memoryKind !== 'human_profile_fact') {
    throw new Error('institutional memory kind is invalid');
  }
  if (proposal.audience !== 'workspace' && proposal.audience !== 'human_profile') {
    throw new Error('institutional memory audience is invalid');
  }
  if (
    typeof proposal.confidence !== 'number' ||
    !Number.isFinite(proposal.confidence) ||
    proposal.confidence < 0 ||
    proposal.confidence > 1
  ) {
    throw new Error('institutional memory confidence is invalid');
  }

  const source = record(proposal.source, 'institutional memory source');
  exactKeys(source, ['roomId', 'messageIds'], 'institutional memory source');
  const roomId = boundedText(source.roomId, 'institutional memory source room', 200);
  if (
    !Array.isArray(source.messageIds) ||
    source.messageIds.length === 0 ||
    source.messageIds.length > INSTITUTIONAL_MEMORY_SOURCE_MESSAGE_MAX
  ) {
    throw new Error('institutional memory source messages are invalid');
  }
  const messageIds = source.messageIds.map((messageId) =>
    boundedText(messageId, 'institutional memory source message', 200),
  );
  if (new Set(messageIds).size !== messageIds.length) {
    throw new Error('institutional memory source messages must be unique');
  }

  const classification = record(proposal.classification, 'institutional memory classification');
  exactKeys(
    classification,
    ['stillTrueForAnotherRequester', 'rationale'],
    'institutional memory classification',
  );
  if (typeof classification.stillTrueForAnotherRequester !== 'boolean') {
    throw new Error('institutional memory classification test is invalid');
  }
  const rationale = boundedText(
    classification.rationale,
    'institutional memory classification rationale',
    INSTITUTIONAL_MEMORY_RATIONALE_MAX_LENGTH,
  );

  const cas = record(proposal.cas, 'institutional memory CAS');
  exactKeys(cas, ['baseVersion', 'supersedesItemId'], 'institutional memory CAS');
  if (
    cas.baseVersion !== null &&
    (!Number.isSafeInteger(cas.baseVersion) || (cas.baseVersion as number) < 0)
  ) {
    throw new Error('institutional memory base version is invalid');
  }
  const supersedesItemId =
    cas.supersedesItemId === undefined
      ? undefined
      : boundedText(cas.supersedesItemId, 'institutional memory supersedes item', 200);

  const workspaceFact = proposal.memoryKind === 'workspace_fact';
  if (workspaceFact !== classification.stillTrueForAnotherRequester) {
    throw new Error('institutional memory kind contradicts the requester test');
  }
  if ((proposal.audience === 'workspace') !== workspaceFact) {
    throw new Error('institutional memory audience contradicts its kind');
  }
  if (proposal.candidateType === 'fact_candidate' && !workspaceFact) {
    throw new Error('institutional memory fact candidates must be workspace facts');
  }
  if (proposal.candidateType === 'preference_candidate' && workspaceFact) {
    throw new Error('institutional memory preference candidates must be human profile facts');
  }
  const subjectIdentityId =
    proposal.subjectIdentityId === undefined
      ? undefined
      : boundedText(proposal.subjectIdentityId, 'institutional memory profile subject', 200);
  if (workspaceFact === Boolean(subjectIdentityId)) {
    throw new Error(
      workspaceFact
        ? 'workspace facts cannot name a profile subject'
        : 'human profile facts require a subject',
    );
  }

  return {
    proposalVersion: INSTITUTIONAL_MEMORY_PROPOSAL_VERSION,
    candidateType: proposal.candidateType,
    memoryKind: proposal.memoryKind,
    ...(subjectIdentityId ? { subjectIdentityId } : {}),
    canonicalKey: boundedText(
      proposal.canonicalKey,
      'institutional memory canonical key',
      INSTITUTIONAL_MEMORY_CANONICAL_KEY_MAX_LENGTH,
    ),
    body: boundedText(
      proposal.body,
      'institutional memory body',
      INSTITUTIONAL_MEMORY_BODY_MAX_BYTES,
      true,
    ),
    source: { roomId, messageIds },
    audience: proposal.audience,
    confidence: proposal.confidence,
    classification: {
      stillTrueForAnotherRequester: classification.stillTrueForAnotherRequester,
      rationale,
    },
    cas: {
      baseVersion: cas.baseVersion as number | null,
      ...(supersedesItemId ? { supersedesItemId } : {}),
    },
  };
}
