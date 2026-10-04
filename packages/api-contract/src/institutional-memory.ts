/** Institutional-memory extraction, storage, and bounded prompt contract. */
import type { DaemonAttachment } from './daemon-operations.js';

export const INSTITUTIONAL_MEMORY_PROPOSAL_VERSION = 1 as const;
/**
 * A saved item is one short sentence. Rows written before this cap may be
 * longer (the table still accepts 4,000 bytes); they stay stored and only load
 * when they fit the turn budget below.
 */
export const INSTITUTIONAL_MEMORY_BODY_MAX_BYTES = 200;
/** Every saved item names 1..6 keywords; only a keyword match loads it. */
export const INSTITUTIONAL_MEMORY_KEYWORDS_MIN = 1;
export const INSTITUTIONAL_MEMORY_KEYWORDS_MAX = 6;
/** Lower-case word, 3..32 characters, the same alphabet request words are split on. */
export const INSTITUTIONAL_MEMORY_KEYWORD_PATTERN = /^[a-z0-9][a-z0-9_./-]{2,31}$/;
/** Words too common to mean anything: never a keyword, never a match. */
export const INSTITUTIONAL_MEMORY_STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'you',
  'your',
  'for',
  'with',
  'that',
  'this',
  'are',
  'was',
  'were',
  'but',
  'not',
  'have',
  'has',
  'had',
  'can',
  'all',
  'any',
  'our',
  'out',
  'use',
  'get',
  'got',
  'how',
  'what',
  'when',
  'who',
  'why',
  'will',
  'just',
  'from',
  'they',
  'them',
  'then',
  'than',
  'there',
  'here',
  'about',
  'into',
  'also',
  'its',
  "it's",
  'please',
  'should',
  'would',
  'could',
  'some',
  'more',
  'most',
  'very',
  'only',
  'one',
  'now',
  'yes',
  'okay',
  'let',
  'make',
  'want',
  'need',
  'does',
  'did',
  'done',
  'like',
  'know',
  'think',
  'see',
  'look',
  'thing',
  'things',
  'way',
]);

/** The words of a request that a keyword can match: lower-case, no stopwords. */
export function institutionalMemoryRequestWords(
  ...values: Array<string | null | undefined>
): Set<string> {
  return new Set(
    (
      values
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLocaleLowerCase('en-US')
        .match(/[a-z0-9][a-z0-9_./-]{2,31}/g) ?? []
    )
      .filter((word) => !INSTITUTIONAL_MEMORY_STOPWORDS.has(word))
      .slice(0, 200),
  );
}
/**
 * The retired standing-preference key. Startup migration renames every row
 * that used it to an ordinary profile fact; the key stays reserved so an older
 * server image in a rolling deploy never serves a new row as every-turn text.
 */
export const INSTITUTIONAL_RETIRED_STANDING_KEY = 'standing';
export const INSTITUTIONAL_MEMORY_CANONICAL_KEY_MAX_LENGTH = 160;
export const INSTITUTIONAL_MEMORY_RATIONALE_MAX_LENGTH = 500;
export const INSTITUTIONAL_MEMORY_SOURCE_MESSAGE_MAX = 16;
/** Everything memory adds to one turn, header included. */
export const INSTITUTIONAL_CONTEXT_HARD_MAX_BYTES = 1_000;
export const INSTITUTIONAL_HISTORY_QUERY_MAX_BYTES = 500;
export const INSTITUTIONAL_MEMORY_SEARCH_QUERY_MAX_BYTES = 500;
export const INSTITUTIONAL_MEMORY_SEARCH_RESULT_MAX = 10;
/**
 * search_memory matches on the query's individual words (the same tokenizer
 * and keyword-overlap semantics the per-turn snapshot uses), scanned newest
 * first and ranked by word-overlap before the result limit above applies.
 */
export const INSTITUTIONAL_MEMORY_SEARCH_SCAN_MAX = 200;
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
/**
 * Meaning-based recall for saved items, workspace skills and the per-turn
 * snapshot. voyage-4-lite (OpenRouter, paid — never a `:free` model, whose
 * inputs a provider may train on) supports Matryoshka embeddings at 2048,
 * 1024, 512 and 256 dimensions; 1024 is the balance of recall quality against
 * pgvector index size this codebase uses everywhere an embedding is stored.
 * The server reads its OpenRouter key from `OPENROUTER_EMBEDDING_API_KEY`
 * (never printed, never committed); see `institutional-memory-embeddings.ts`.
 */
export const INSTITUTIONAL_MEMORY_EMBEDDING_MODEL = 'voyageai/voyage-4-lite';
export const INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS = 1024;
export const INSTITUTIONAL_MEMORY_EMBEDDING_ENV_VAR = 'OPENROUTER_EMBEDDING_API_KEY';
/** Nearest-neighbor candidates pulled per hybrid search, before the result limit applies. */
export const INSTITUTIONAL_MEMORY_VECTOR_CANDIDATES_MAX = 20;
export const INSTITUTIONAL_MEMORY_VECTOR_MAX_DISTANCE = 0.66;
export const INSTITUTIONAL_CONTEXT_VECTOR_ITEMS_MAX = 3;
export const INSTITUTIONAL_MEMORY_ALIGN_MAX_DISTANCE = 0.75;
/** A snapshot's embedding call gets a slice of the whole 500ms context-fetch
 *  budget (`INSTITUTIONAL_CONTEXT_TIMEOUT_MS`, apps/body/src/institutional-context.ts);
 *  the rest stays for the DB queries the snapshot already runs. A miss here
 *  degrades to keyword-only candidates, never to an empty snapshot. Raised
 *  100ms→400ms after production showed real OpenRouter embedding calls
 *  routinely exceeding 100ms, so the budget never let one actually land. */
export const INSTITUTIONAL_CONTEXT_EMBEDDING_TIMEOUT_MS = 400;
export const WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH = 60;
export const WORKSPACE_SKILL_MARKDOWN_MAX_BYTES = 32 * 1_024;
export const WORKSPACE_SKILL_SLUG_MAX_LENGTH = 64;
export const INSTITUTIONAL_CURATOR_ACTION_MAX = 50;

export type InstitutionalMemoryCandidateType =
  'correction_candidate' | 'fact_candidate' | 'preference_candidate';
export type InstitutionalMemoryKind = 'workspace_fact' | 'human_profile_fact';
export type InstitutionalMemoryAudience = 'workspace' | 'human_profile';
export type InstitutionalMemoryItemState = 'active' | 'stale';
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
  readonly keywords: readonly string[];
  readonly source: InstitutionalMemoryProposalSource;
  readonly audience: InstitutionalMemoryAudience;
  readonly confidence: number;
  readonly classification: {
    /** Legacy classifier signal; scope is determined by the fact's subject. */
    readonly stillTrueForAnotherRequester?: boolean;
    readonly subjectIsRequester?: boolean;
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

export interface InstitutionalContextSnapshot {
  readonly snapshotRevision: number;
  /** Empty means memory was unavailable or nothing was relevant. */
  readonly text: string;
  readonly itemIds: readonly string[];
  readonly totalBytes: number;
  readonly omitted: Readonly<Record<string, number>>;
  /** This snapshot's own embedding round trip, for the turn trace. Absent
   *  when memory is off for the Workspace; `disabled` when no key is configured. */
  readonly embeddingMs?: number;
  readonly embeddingOutcome?: 'served' | 'timed-out' | 'disabled' | 'error';
}

/** Turn-bound fields every memory write carries. */
interface InstitutionalMemoryWriteInput {
  readonly agentId: string;
  readonly roomId: string;
  readonly requestId?: string;
  readonly generationId?: string;
  /** Current Room message ids the change rests on, the root request first or among them. */
  readonly sourceMessageIds: readonly string[];
  /**
   * True only when a person in the cited messages explicitly asked for this:
   * to keep a fact (a standing order, which never expires) or to correct or
   * delete one.
   */
  readonly personAsked: boolean;
}

export interface SaveInstitutionalMemoryInput extends InstitutionalMemoryWriteInput {
  readonly memoryKind: InstitutionalMemoryKind;
  readonly canonicalKey: string;
  readonly body: string;
  readonly keywords: readonly string[];
  readonly confidence: number;
}

export interface UpdateInstitutionalMemoryInput extends InstitutionalMemoryWriteInput {
  readonly itemId: string;
  /** The item's current version; any other version is refused. */
  readonly version: number;
  readonly body: string;
  /** Replaces the keywords; omitted keeps the item's own. */
  readonly keywords?: readonly string[];
}

export interface DeleteInstitutionalMemoryInput extends InstitutionalMemoryWriteInput {
  readonly itemId: string;
  readonly version: number;
  readonly reason: 'wrong' | 'duplicate' | 'obsolete';
}

export interface InstitutionalMemoryWriteResult {
  readonly itemId: string;
  readonly version: number;
}

/**
 * The items this turn's answer relied on. Only this report, a save, or an
 * update keeps a Workspace fact from expiring; being loaded into a snapshot or
 * returned by search does not.
 */
export interface ReportInstitutionalMemoryUsedInput {
  readonly agentId: string;
  readonly roomId: string;
  readonly requestId?: string;
  readonly generationId?: string;
  /** Item ids from search_memory results. */
  readonly itemIds?: readonly string[];
  /** 1-based numbers of this turn's snapshot lines, as shown in the Memory block. */
  readonly snapshotItems?: readonly number[];
}

export interface ReportInstitutionalMemoryUsedResult {
  readonly refreshed: number;
}

export interface SearchInstitutionalMemoryInput {
  readonly agentId: string;
  readonly roomId: string;
  readonly requestId?: string;
  readonly generationId?: string;
  readonly query: string;
  readonly limit?: number;
}

/** How many times this turn called search_memory, and how many of those
 *  calls came back with nothing — read back by the body's turn trace after
 *  the turn settles (`institutional_context_serves`' own counters; see
 *  `searchInstitutionalMemory` and `getInstitutionalMemoryTurnStats`). */
export interface InstitutionalMemoryTurnStats {
  readonly searchCalls: number;
  readonly searchMisses: number;
}

export interface SearchInstitutionalMemoryResult {
  /** Quoted, fallible context; never instructions or authority. */
  readonly results: readonly (Pick<
    InstitutionalMemoryItem,
    'id' | 'kind' | 'canonicalKey' | 'body' | 'version'
  > & {
    /** A person asked to keep it: change it only on a person's instruction. */
    readonly standingOrder: boolean;
  })[];
  readonly quotedContext: true;
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
  readonly activeRunIds?: readonly string[];
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

/** An optional field a model left inapplicable: absent and explicit null agree. */
function omitted(value: unknown): boolean {
  return value === undefined || value === null;
}

function boundedText(value: unknown, label: string, maximum: number, bytes = false): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  const size = bytes ? new TextEncoder().encode(normalized).length : normalized.length;
  if (!normalized || size > maximum) throw new Error(`${label} is invalid`);
  return normalized;
}

const FILLER_OPENINGS =
  /^(?:the user|user|this user|the requester|requester|it is|it's|note that|please|remember that|keep in mind)\b/i;
const HEDGES = /\b(?:maybe|perhaps|probably|possibly|might|seems?|i think|apparently|likely)\b/i;

/**
 * Save-time trim: one terse sentence of fact, no filler opening, no hedge.
 * The error says what to cut so the proposer can resubmit.
 */
export function conciseInstitutionalMemoryBody(value: unknown): string {
  const body = boundedText(
    value,
    `institutional memory body (at most ${INSTITUTIONAL_MEMORY_BODY_MAX_BYTES} bytes)`,
    INSTITUTIONAL_MEMORY_BODY_MAX_BYTES,
    true,
  );
  if (FILLER_OPENINGS.test(body)) {
    throw new Error(
      'institutional memory body must state the fact itself, without a filler opening',
    );
  }
  if (/[.!?;]\s+\S/.test(body) || /\n/.test(body)) {
    throw new Error('institutional memory body must be one sentence');
  }
  if (HEDGES.test(body)) {
    throw new Error('institutional memory body must not hedge; save only what is known');
  }
  return body;
}

export function institutionalMemoryKeywords(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < INSTITUTIONAL_MEMORY_KEYWORDS_MIN ||
    value.length > INSTITUTIONAL_MEMORY_KEYWORDS_MAX
  ) {
    throw new Error(
      `institutional memory needs ${INSTITUTIONAL_MEMORY_KEYWORDS_MIN} to ${INSTITUTIONAL_MEMORY_KEYWORDS_MAX} keywords`,
    );
  }
  const keywords = value.map((keyword) =>
    typeof keyword === 'string' ? keyword.trim().toLocaleLowerCase('en-US') : '',
  );
  if (
    keywords.some(
      (keyword) =>
        !INSTITUTIONAL_MEMORY_KEYWORD_PATTERN.test(keyword) ||
        INSTITUTIONAL_MEMORY_STOPWORDS.has(keyword),
    )
  ) {
    throw new Error(
      'institutional memory keywords are distinctive single lower-case words of 3 to 32 letters, digits, or _./-',
    );
  }
  if (new Set(keywords).size !== keywords.length) {
    throw new Error('institutional memory keywords must be unique');
  }
  return keywords;
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
      'keywords',
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
    ['stillTrueForAnotherRequester', 'subjectIsRequester', 'rationale'],
    'institutional memory classification',
  );
  if (
    classification.stillTrueForAnotherRequester !== undefined &&
    typeof classification.stillTrueForAnotherRequester !== 'boolean'
  ) {
    throw new Error('institutional memory classification test is invalid');
  }
  if (
    classification.subjectIsRequester !== undefined &&
    typeof classification.subjectIsRequester !== 'boolean'
  ) {
    throw new Error('institutional memory subject classification is invalid');
  }
  const canonicalKey = boundedText(
    proposal.canonicalKey,
    'institutional memory canonical key',
    INSTITUTIONAL_MEMORY_CANONICAL_KEY_MAX_LENGTH,
  );
  if (canonicalKey === INSTITUTIONAL_RETIRED_STANDING_KEY) {
    throw new Error('the canonical key "standing" is retired');
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
  if (
    classification.subjectIsRequester !== undefined &&
    classification.subjectIsRequester === workspaceFact
  ) {
    throw new Error('institutional memory kind contradicts its subject');
  }
  if ((proposal.audience === 'workspace') !== workspaceFact) {
    throw new Error('institutional memory audience contradicts its kind');
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
    canonicalKey,
    body: conciseInstitutionalMemoryBody(proposal.body),
    keywords: institutionalMemoryKeywords(proposal.keywords),
    source: { roomId, messageIds },
    audience: proposal.audience,
    confidence: proposal.confidence,
    classification: {
      ...(classification.stillTrueForAnotherRequester === undefined
        ? {}
        : {
            stillTrueForAnotherRequester: classification.stillTrueForAnotherRequester,
          }),
      ...(classification.subjectIsRequester === undefined
        ? {}
        : {
            subjectIsRequester: classification.subjectIsRequester,
          }),
      rationale,
    },
    cas: {
      baseVersion: cas.baseVersion as number | null,
      ...(supersedesItemId ? { supersedesItemId } : {}),
    },
  };
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
    const body = omitted(action.body)
      ? undefined
      : action.targetType === 'memory_item'
        ? conciseInstitutionalMemoryBody(action.body)
        : boundedText(
            action.body,
            'institutional curator body',
            INSTITUTIONAL_MEMORY_BODY_MAX_BYTES,
            true,
          );
    const description = omitted(action.description)
      ? undefined
      : boundedText(
          action.description,
          'institutional curator skill description',
          WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH,
        );
    const markdown = omitted(action.markdown)
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
