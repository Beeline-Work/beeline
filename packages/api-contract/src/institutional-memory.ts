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
export const INSTITUTIONAL_CONTEXT_SKILL_INDEX_MAX_BYTES = 1_800;
export const INSTITUTIONAL_CONTEXT_WRAPPER_MAX_BYTES = 700;
export const INSTITUTIONAL_HISTORY_QUERY_MAX_BYTES = 500;
export const INSTITUTIONAL_HISTORY_RESULT_MAX = 10;
export const INSTITUTIONAL_HISTORY_SNIPPET_MAX_BYTES = 360;
/**
 * Ranking is bounded to this many matched rows: a broad query in a large
 * Workspace must never rank (or count) every match it could reach.
 */
export const INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX = 200;
/**
 * Matching is bounded to this recency window. A GIN index cannot return rows in
 * recency order, so without a time bound one common term would sort every match
 * in history before the row bound above could apply.
 */
export const INSTITUTIONAL_HISTORY_MAX_AGE_DAYS = 180;
export const WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH = 60;
export const WORKSPACE_SKILL_MARKDOWN_MAX_BYTES = 32 * 1_024;
export const WORKSPACE_SKILL_SLUG_MAX_LENGTH = 64;
export const INSTITUTIONAL_REVIEW_FINDING_MAX = 20;
export const INSTITUTIONAL_CURATOR_ACTION_MAX = 50;

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
  readonly proposal?: InstitutionalMemoryJobProposal | null;
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
  readonly triggerKind: 'turn_review' | 'merge_review' | 'curator';
  readonly context?: Readonly<Record<string, unknown>>;
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
  readonly proposal: InstitutionalMemoryJobProposal | null;
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
  /** The recency window searched, in days. */
  readonly windowDays: number;
  readonly omitted: number;
  /** True when matching stopped at INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX, so
   * `omitted` counts the bounded match set and not every Workspace match. */
  readonly capped: boolean;
}

export interface WorkspaceSkillCodeAnchor {
  readonly repository: string;
  readonly targetCommit: string;
  readonly path?: string;
}

export interface WorkspaceSkillProposal {
  readonly slug: string;
  readonly description: string;
  readonly markdown: string;
  readonly baseVersion: number | null;
  readonly anchor: WorkspaceSkillCodeAnchor;
}

export interface InstitutionalReviewFindingProposal {
  readonly taxonomy: string;
  readonly summary: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly confidence: number;
  readonly path?: string;
}

export interface InstitutionalMergeReviewProposal {
  readonly proposalVersion: 1;
  readonly skill: WorkspaceSkillProposal | null;
  readonly findings: readonly InstitutionalReviewFindingProposal[];
}

export interface InstitutionalCuratorAction {
  readonly action: 'retain' | 'stale' | 'archive' | 'consolidate';
  readonly targetType: 'memory_item' | 'workspace_skill';
  readonly targetId: string;
  readonly baseVersion: number;
  readonly duplicateIds: readonly string[];
  readonly body?: string;
  readonly description?: string;
  readonly markdown?: string;
  readonly rationale: string;
}

export interface InstitutionalCuratorProposal {
  readonly proposalVersion: 1;
  readonly partition: string;
  readonly actions: readonly InstitutionalCuratorAction[];
}

export type InstitutionalMemoryJobProposal =
  InstitutionalMemoryProposal | InstitutionalMergeReviewProposal | InstitutionalCuratorProposal;

export interface LoadWorkspaceSkillInput {
  readonly agentId: string;
  readonly roomId: string;
  readonly requestId?: string;
  readonly generationId?: string;
  readonly slug: string;
}

export interface LoadWorkspaceSkillResult {
  readonly skillId: string;
  readonly slug: string;
  readonly description: string;
  readonly version: number;
  readonly markdown: string;
  readonly sourceRoomId: string;
  readonly anchor: WorkspaceSkillCodeAnchor;
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

/** Strict parser for one merge-derived, restricted procedure proposal. */
/**
 * A path the model can name from its own evidence is kept; an unverifiable value
 * is DROPPED rather than kept or treated as fatal, because rejecting would
 * discard a whole valid procedure and its review findings over metadata the
 * model was told was optional.
 *
 * There is no content-digest field: the model is given no file bytes, so any
 * digest it emitted would be asserted rather than computed. Staling a procedure
 * on code-anchor mismatch needs a producer that reads the anchored file, which
 * is not part of this change (see AGENTS.md).
 */
function repositoryRelativePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return undefined;
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    return undefined;
  }
  return value;
}

function optionalAnchorField(key: 'path', value: string | undefined) {
  return value === undefined ? {} : { [key]: value };
}

export function parseInstitutionalMergeReviewProposal(
  value: unknown,
): InstitutionalMergeReviewProposal {
  const proposal = record(value, 'institutional merge review proposal');
  exactKeys(
    proposal,
    ['proposalVersion', 'skill', 'findings'],
    'institutional merge review proposal',
  );
  if (proposal.proposalVersion !== 1) {
    throw new Error('institutional merge review proposal version is unsupported');
  }
  let skill: WorkspaceSkillProposal | null = null;
  if (proposal.skill !== null) {
    const rawSkill = record(proposal.skill, 'workspace skill proposal');
    exactKeys(
      rawSkill,
      ['slug', 'description', 'markdown', 'baseVersion', 'anchor'],
      'workspace skill proposal',
    );
    const slug = boundedText(
      rawSkill.slug,
      'workspace skill slug',
      WORKSPACE_SKILL_SLUG_MAX_LENGTH,
    );
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error('workspace skill slug is invalid');
    }
    const anchor = record(rawSkill.anchor, 'workspace skill code anchor');
    // `contentHash` is TOLERATED and dropped, never stored: a host still running
    // the older prompt would otherwise lose its whole review to an unknown-field
    // refusal. The model is given no file bytes, so any digest it emits is
    // asserted rather than computed, and nothing reads one.
    exactKeys(
      anchor,
      ['repository', 'targetCommit', 'path', 'contentHash'],
      'workspace skill code anchor',
    );
    if (
      rawSkill.baseVersion !== null &&
      (!Number.isSafeInteger(rawSkill.baseVersion) || (rawSkill.baseVersion as number) <= 0)
    ) {
      throw new Error('workspace skill base version is invalid');
    }
    skill = {
      slug,
      description: boundedText(
        rawSkill.description,
        'workspace skill description',
        WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH,
      ),
      markdown: boundedText(
        rawSkill.markdown,
        'workspace skill markdown',
        WORKSPACE_SKILL_MARKDOWN_MAX_BYTES,
        true,
      ),
      baseVersion: rawSkill.baseVersion as number | null,
      anchor: {
        repository: boundedText(anchor.repository, 'workspace skill repository', 300),
        targetCommit: boundedText(anchor.targetCommit, 'workspace skill target commit', 160),
        ...optionalAnchorField('path', repositoryRelativePath(anchor.path)),
      },
    };
  }
  if (
    !Array.isArray(proposal.findings) ||
    proposal.findings.length > INSTITUTIONAL_REVIEW_FINDING_MAX
  ) {
    throw new Error('institutional review findings are invalid');
  }
  const findings = proposal.findings.map<InstitutionalReviewFindingProposal>((value) => {
    const finding = record(value, 'institutional review finding');
    exactKeys(
      finding,
      ['taxonomy', 'summary', 'severity', 'confidence', 'path'],
      'institutional review finding',
    );
    if (
      finding.severity !== 'info' &&
      finding.severity !== 'warning' &&
      finding.severity !== 'error'
    ) {
      throw new Error('institutional review finding severity is invalid');
    }
    const severity = finding.severity;
    if (
      typeof finding.confidence !== 'number' ||
      !Number.isFinite(finding.confidence) ||
      finding.confidence < 0 ||
      finding.confidence > 1
    ) {
      throw new Error('institutional review finding confidence is invalid');
    }
    return {
      taxonomy: boundedText(finding.taxonomy, 'institutional review finding taxonomy', 120),
      summary: boundedText(finding.summary, 'institutional review finding summary', 1_000),
      severity,
      confidence: finding.confidence,
      ...(finding.path === undefined
        ? {}
        : { path: boundedText(finding.path, 'institutional review finding path', 500) }),
    };
  });
  return { proposalVersion: 1, skill, findings };
}

export function parseInstitutionalCuratorProposal(value: unknown): InstitutionalCuratorProposal {
  const proposal = record(value, 'institutional curator proposal');
  exactKeys(
    proposal,
    ['proposalVersion', 'partition', 'actions'],
    'institutional curator proposal',
  );
  if (proposal.proposalVersion !== 1) {
    throw new Error('institutional curator proposal version is unsupported');
  }
  const partition = boundedText(proposal.partition, 'institutional curator partition', 300);
  if (
    !Array.isArray(proposal.actions) ||
    proposal.actions.length > INSTITUTIONAL_CURATOR_ACTION_MAX
  ) {
    throw new Error('institutional curator actions are invalid');
  }
  const actions = proposal.actions.map<InstitutionalCuratorAction>((value) => {
    const action = record(value, 'institutional curator action');
    exactKeys(
      action,
      [
        'action',
        'targetType',
        'targetId',
        'baseVersion',
        'duplicateIds',
        'body',
        'description',
        'markdown',
        'rationale',
      ],
      'institutional curator action',
    );
    if (
      action.action !== 'retain' &&
      action.action !== 'stale' &&
      action.action !== 'archive' &&
      action.action !== 'consolidate'
    ) {
      throw new Error('institutional curator action kind is invalid');
    }
    if (action.targetType !== 'memory_item' && action.targetType !== 'workspace_skill') {
      throw new Error('institutional curator target type is invalid');
    }
    if (!Number.isSafeInteger(action.baseVersion) || (action.baseVersion as number) <= 0) {
      throw new Error('institutional curator base version is invalid');
    }
    if (
      !Array.isArray(action.duplicateIds) ||
      action.duplicateIds.length > 20 ||
      action.duplicateIds.some((id) => typeof id !== 'string' || !id || id.length > 100)
    ) {
      throw new Error('institutional curator duplicate ids are invalid');
    }
    if (action.action === 'consolidate' && action.duplicateIds.length === 0) {
      throw new Error('institutional curator consolidation needs duplicates');
    }
    if (action.action !== 'consolidate' && action.duplicateIds.length !== 0) {
      throw new Error('institutional curator lifecycle action cannot carry duplicates');
    }
    const body =
      action.body === undefined
        ? undefined
        : boundedText(
            action.body,
            'institutional curator body',
            INSTITUTIONAL_MEMORY_BODY_MAX_BYTES,
            true,
          );
    const description =
      action.description === undefined
        ? undefined
        : boundedText(
            action.description,
            'institutional curator skill description',
            WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH,
          );
    const markdown =
      action.markdown === undefined
        ? undefined
        : boundedText(
            action.markdown,
            'institutional curator skill markdown',
            WORKSPACE_SKILL_MARKDOWN_MAX_BYTES,
            true,
          );
    if (
      action.action === 'consolidate' &&
      ((action.targetType === 'memory_item' && (!body || description || markdown)) ||
        (action.targetType === 'workspace_skill' && (!description || !markdown || body)))
    ) {
      throw new Error('institutional curator consolidation content is invalid');
    }
    if (action.action !== 'consolidate' && (body || description || markdown)) {
      throw new Error('institutional curator lifecycle action cannot replace content');
    }
    return {
      action: action.action,
      targetType: action.targetType,
      targetId: boundedText(action.targetId, 'institutional curator target id', 100),
      baseVersion: action.baseVersion as number,
      duplicateIds: [...new Set(action.duplicateIds as string[])],
      ...(body ? { body } : {}),
      ...(description ? { description } : {}),
      ...(markdown ? { markdown } : {}),
      rationale: boundedText(action.rationale, 'institutional curator rationale', 500),
    };
  });
  return { proposalVersion: 1, partition, actions };
}
