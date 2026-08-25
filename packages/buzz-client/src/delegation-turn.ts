/**
 * Typed, bounded agent-to-agent delegation protocol.
 *
 * Visible `@handle:` text is only authoring syntax. A recipient may take a
 * model turn only after this module has parsed a signed event addressed to its
 * exact pubkey and the host has admitted it against current access/membership
 * state plus the durable graph history.
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { KIND_STREAM_MESSAGE, TAG_DELEGATION_RECEIPT, TAG_DELEGATION_TURN } from './kinds.js';
import type { Identity } from './types.js';
import type { ArtifactRevisionRef } from './permission-request.js';

export const DELEGATION_TURN_MARKER = TAG_DELEGATION_TURN;
export const DELEGATION_RECEIPT_MARKER = TAG_DELEGATION_RECEIPT;
export const DELEGATION_PROTOCOL_VERSION = 1 as const;

export const DEFAULT_DELEGATION_MAX_AGENT_TURNS = 8;
export const DEFAULT_DELEGATION_MAX_DEPTH = 4;
export const DEFAULT_DELEGATION_MAX_CHILDREN = 4;
export const DEFAULT_DELEGATION_DEADLINE_SECONDS = 30 * 60;
export const MAX_DELEGATION_TASK_CHARS = 1_200;
export const MAX_DELEGATION_DIRECTIVES_PER_TURN = 4;
export const MAX_DELEGATION_RESERVED_TOKENS = 10_000_000;
export const MAX_DELEGATION_CONTENT_CHARS = 32_000;

const HEX_64 = /^[0-9a-f]{64}$/;
const PROTOCOL_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SHA_256 = /^[0-9a-f]{64}$/;

type JsonRecord = Record<string, unknown>;

export interface DelegationBudgetV1 {
  maxAgentTurns: number;
  maxDepth: number;
  maxChildren: number;
  reservedTokens: number;
  deadlineAt: number;
}

export interface DelegationTurnV1 {
  version: 1;
  delegationId: string;
  workItemId: string;
  phase: 'assign' | 'return';
  roomId: string;
  workspaceId: string;
  fromAgentPubkey: string;
  toAgentPubkey: string;
  rootEventId: string;
  parentEventId: string;
  parentWorkItemId?: string;
  principalPubkey: string;
  path: string[];
  depth: number;
  budget: DelegationBudgetV1;
  task: string;
  artifactRefs?: ArtifactRevisionRef[];
  escalationGrantEventId?: string;
  createdAt: number;
}

export type DelegationReceiptStatus =
  'queued' | 'working' | 'complete' | 'failed' | 'refused' | 'budget-exhausted';

export interface DelegationReceiptV1 {
  version: 1;
  delegationId: string;
  workItemId: string;
  turnEventId: string;
  status: DelegationReceiptStatus;
  at: number;
  reason?: string;
}

export type ParsedDelegationTurn = {
  type: 'turn';
  event: NostrEvent;
  value: DelegationTurnV1;
};

export type ParsedDelegationReceipt = {
  type: 'receipt';
  event: NostrEvent;
  value: DelegationReceiptV1;
};

export type ParsedDelegationEvent = ParsedDelegationTurn | ParsedDelegationReceipt;

function object(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmpty(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

function token(value: unknown, max = 256): string | undefined {
  const candidate = nonEmpty(value, max);
  return candidate && SAFE_TOKEN.test(candidate) ? candidate : undefined;
}

function protocolId(value: unknown): string | undefined {
  const candidate = nonEmpty(value, 64);
  return candidate && PROTOCOL_ID.test(candidate) ? candidate : undefined;
}

function pubkey(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_64.test(value) ? value : undefined;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : undefined;
}

function uniquePubkeys(value: unknown, max = 32): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return undefined;
  const parsed = value.map(pubkey);
  if (parsed.some((candidate) => !candidate)) return undefined;
  const result = parsed as string[];
  return new Set(result).size === result.length ? result : undefined;
}

function parseArtifact(value: unknown): ArtifactRevisionRef | undefined {
  const input = object(value);
  const artifactId = token(input?.artifactId);
  const revision = integer(input?.revision, 1);
  const eventId =
    typeof input?.eventId === 'string' && HEX_64.test(input.eventId) ? input.eventId : undefined;
  const sha256 =
    typeof input?.sha256 === 'string' && SHA_256.test(input.sha256) ? input.sha256 : undefined;
  return input && artifactId && revision !== undefined && eventId && sha256
    ? { artifactId, revision, eventId, sha256 }
    : undefined;
}

function parseArtifacts(value: unknown): ArtifactRevisionRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return undefined;
  const parsed = value.map(parseArtifact);
  if (parsed.some((candidate) => !candidate)) return undefined;
  const artifacts = parsed as ArtifactRevisionRef[];
  const ids = artifacts.map(
    (artifact) => `${artifact.artifactId}:${artifact.revision}:${artifact.eventId}`,
  );
  return new Set(ids).size === ids.length ? artifacts : undefined;
}

export function parseDelegationBudget(value: unknown): DelegationBudgetV1 | undefined {
  const input = object(value);
  const maxAgentTurns = integer(input?.maxAgentTurns, 1, 1_000);
  const maxDepth = integer(input?.maxDepth, 1, 32);
  const maxChildren = integer(input?.maxChildren, 1, 32);
  const reservedTokens = integer(input?.reservedTokens, 0, MAX_DELEGATION_RESERVED_TOKENS);
  const deadlineAt = integer(input?.deadlineAt);
  if (
    !input ||
    maxAgentTurns === undefined ||
    maxDepth === undefined ||
    maxChildren === undefined ||
    reservedTokens === undefined ||
    deadlineAt === undefined
  ) {
    return undefined;
  }
  return { maxAgentTurns, maxDepth, maxChildren, reservedTokens, deadlineAt };
}

export function defaultDelegationBudget(createdAt: number, reservedTokens = 0): DelegationBudgetV1 {
  return {
    maxAgentTurns: DEFAULT_DELEGATION_MAX_AGENT_TURNS,
    maxDepth: DEFAULT_DELEGATION_MAX_DEPTH,
    maxChildren: DEFAULT_DELEGATION_MAX_CHILDREN,
    reservedTokens,
    deadlineAt: createdAt + DEFAULT_DELEGATION_DEADLINE_SECONDS,
  };
}

function parseTurnContent(value: unknown): DelegationTurnV1 | undefined {
  const input = object(value);
  const delegationId = protocolId(input?.delegationId);
  const workItemId = protocolId(input?.workItemId);
  const roomId = token(input?.roomId);
  const workspaceId = token(input?.workspaceId);
  const fromAgentPubkey = pubkey(input?.fromAgentPubkey);
  const toAgentPubkey = pubkey(input?.toAgentPubkey);
  const rootEventId =
    typeof input?.rootEventId === 'string' && HEX_64.test(input.rootEventId)
      ? input.rootEventId
      : undefined;
  const parentEventId =
    typeof input?.parentEventId === 'string' && HEX_64.test(input.parentEventId)
      ? input.parentEventId
      : undefined;
  const parentWorkItemId =
    input?.parentWorkItemId === undefined ? undefined : protocolId(input.parentWorkItemId);
  const principalPubkey = pubkey(input?.principalPubkey);
  const path = uniquePubkeys(input?.path);
  const depth = integer(input?.depth, 1, 32);
  const budget = parseDelegationBudget(input?.budget);
  const task = nonEmpty(input?.task, MAX_DELEGATION_TASK_CHARS);
  const artifactRefs =
    input?.artifactRefs === undefined ? undefined : parseArtifacts(input.artifactRefs);
  const escalationGrantEventId =
    input?.escalationGrantEventId === undefined
      ? undefined
      : typeof input.escalationGrantEventId === 'string' &&
          HEX_64.test(input.escalationGrantEventId)
        ? input.escalationGrantEventId
        : undefined;
  const createdAt = integer(input?.createdAt);
  if (
    input?.version !== 1 ||
    !delegationId ||
    !workItemId ||
    !['assign', 'return'].includes(String(input?.phase)) ||
    !roomId ||
    !workspaceId ||
    !fromAgentPubkey ||
    !toAgentPubkey ||
    !rootEventId ||
    !parentEventId ||
    (input.parentWorkItemId !== undefined && !parentWorkItemId) ||
    !principalPubkey ||
    !path ||
    depth === undefined ||
    depth !== path.length ||
    !budget ||
    !task ||
    (input.artifactRefs !== undefined && !artifactRefs) ||
    (input.escalationGrantEventId !== undefined && !escalationGrantEventId) ||
    createdAt === undefined ||
    path[path.length - 1] !== fromAgentPubkey ||
    fromAgentPubkey === toAgentPubkey ||
    (input.phase === 'assign' &&
      (depth === 1 ? parentWorkItemId !== undefined : !parentWorkItemId)) ||
    (input.phase === 'return' && !parentWorkItemId)
  ) {
    return undefined;
  }
  return {
    version: 1,
    delegationId,
    workItemId,
    phase: input.phase as 'assign' | 'return',
    roomId,
    workspaceId,
    fromAgentPubkey,
    toAgentPubkey,
    rootEventId,
    parentEventId,
    ...(parentWorkItemId ? { parentWorkItemId } : {}),
    principalPubkey,
    path,
    depth,
    budget,
    task,
    ...(artifactRefs ? { artifactRefs } : {}),
    ...(escalationGrantEventId ? { escalationGrantEventId } : {}),
    createdAt,
  };
}

function parseReceiptContent(value: unknown): DelegationReceiptV1 | undefined {
  const input = object(value);
  const delegationId = protocolId(input?.delegationId);
  const workItemId = protocolId(input?.workItemId);
  const turnEventId =
    typeof input?.turnEventId === 'string' && HEX_64.test(input.turnEventId)
      ? input.turnEventId
      : undefined;
  const at = integer(input?.at);
  const reason = input?.reason === undefined ? undefined : nonEmpty(input.reason, 600);
  if (
    input?.version !== 1 ||
    !delegationId ||
    !workItemId ||
    !turnEventId ||
    !['queued', 'working', 'complete', 'failed', 'refused', 'budget-exhausted'].includes(
      String(input?.status),
    ) ||
    at === undefined ||
    (input.reason !== undefined && !reason)
  ) {
    return undefined;
  }
  return {
    version: 1,
    delegationId,
    workItemId,
    turnEventId,
    status: input.status as DelegationReceiptStatus,
    at,
    ...(reason ? { reason } : {}),
  };
}

function uniqueTag(event: NostrEvent, name: string): string | undefined {
  const matches = event.tags.filter((candidate) => candidate[0] === name);
  return matches.length === 1 && matches[0]?.[1] ? matches[0][1] : undefined;
}

function marker(event: NostrEvent): string | undefined {
  const values = event.tags.filter((candidate) => candidate[0] === 't');
  return values.length === 1 ? values[0]?.[1] : undefined;
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export function parseDelegationTurn(event: NostrEvent): ParsedDelegationTurn | undefined {
  if (
    event.kind !== KIND_STREAM_MESSAGE ||
    event.content.length > MAX_DELEGATION_CONTENT_CHARS ||
    marker(event) !== DELEGATION_TURN_MARKER ||
    !verifyEvent(event)
  ) {
    return undefined;
  }
  const value = parseTurnContent(parseJson(event.content));
  if (
    !value ||
    event.pubkey !== value.fromAgentPubkey ||
    uniqueTag(event, 'h') !== value.roomId ||
    uniqueTag(event, 'delegation') !== value.delegationId ||
    uniqueTag(event, 'work-item') !== value.workItemId ||
    uniqueTag(event, 'phase') !== value.phase ||
    uniqueTag(event, 'root') !== value.rootEventId ||
    uniqueTag(event, 'parent') !== value.parentEventId ||
    uniqueTag(event, 'from') !== value.fromAgentPubkey ||
    uniqueTag(event, 'p') !== value.toAgentPubkey ||
    uniqueTag(event, 'principal') !== value.principalPubkey ||
    uniqueTag(event, 'depth') !== String(value.depth) ||
    uniqueTag(event, 'deadline') !== String(value.budget.deadlineAt) ||
    event.created_at !== value.createdAt ||
    (value.escalationGrantEventId !== undefined &&
      uniqueTag(event, 'escalation-grant') !== value.escalationGrantEventId) ||
    (value.escalationGrantEventId === undefined &&
      event.tags.some((candidate) => candidate[0] === 'escalation-grant')) ||
    (value.parentWorkItemId !== undefined &&
      uniqueTag(event, 'parent-work-item') !== value.parentWorkItemId) ||
    (value.parentWorkItemId === undefined &&
      event.tags.some((candidate) => candidate[0] === 'parent-work-item'))
  ) {
    return undefined;
  }
  return { type: 'turn', event, value };
}

export function parseDelegationReceipt(event: NostrEvent): ParsedDelegationReceipt | undefined {
  if (
    event.kind !== KIND_STREAM_MESSAGE ||
    event.content.length > MAX_DELEGATION_CONTENT_CHARS ||
    marker(event) !== DELEGATION_RECEIPT_MARKER ||
    !verifyEvent(event)
  ) {
    return undefined;
  }
  const value = parseReceiptContent(parseJson(event.content));
  if (
    !value ||
    uniqueTag(event, 'delegation') !== value.delegationId ||
    uniqueTag(event, 'work-item') !== value.workItemId ||
    uniqueTag(event, 'turn') !== value.turnEventId ||
    uniqueTag(event, 'status') !== value.status ||
    event.created_at !== value.at ||
    !uniqueTag(event, 'h')
  ) {
    return undefined;
  }
  return { type: 'receipt', event, value };
}

export function parseDelegationEvent(event: NostrEvent): ParsedDelegationEvent | undefined {
  if (marker(event) === DELEGATION_TURN_MARKER) return parseDelegationTurn(event);
  if (marker(event) === DELEGATION_RECEIPT_MARKER) return parseDelegationReceipt(event);
  return undefined;
}

function sign(identity: Identity, tags: string[][], value: unknown, createdAt: number): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: createdAt,
      kind: KIND_STREAM_MESSAGE,
      tags,
      content: JSON.stringify(value),
    },
    identity.secretKey,
  );
}

export function buildDelegationTurn(sender: Identity, input: DelegationTurnV1): NostrEvent {
  const value = parseTurnContent(input);
  if (!value || value.fromAgentPubkey !== sender.publicKey)
    throw new Error('invalid delegation turn');
  return sign(
    sender,
    [
      ['h', value.roomId],
      ['t', DELEGATION_TURN_MARKER],
      ['delegation', value.delegationId],
      ['work-item', value.workItemId],
      ['phase', value.phase],
      ['root', value.rootEventId],
      ['parent', value.parentEventId],
      ...(value.parentWorkItemId ? [['parent-work-item', value.parentWorkItemId]] : []),
      ['from', value.fromAgentPubkey],
      ['p', value.toAgentPubkey],
      ['principal', value.principalPubkey],
      ['depth', String(value.depth)],
      ['deadline', String(value.budget.deadlineAt)],
      ...(value.escalationGrantEventId ? [['escalation-grant', value.escalationGrantEventId]] : []),
    ],
    value,
    value.createdAt,
  );
}

export function buildDelegationReceipt(
  signer: Identity,
  roomId: string,
  input: DelegationReceiptV1,
): NostrEvent {
  const value = parseReceiptContent(input);
  if (!value || !token(roomId)) throw new Error('invalid delegation receipt');
  return sign(
    signer,
    [
      ['h', roomId],
      ['t', DELEGATION_RECEIPT_MARKER],
      ['delegation', value.delegationId],
      ['work-item', value.workItemId],
      ['turn', value.turnEventId],
      ['status', value.status],
    ],
    value,
    value.at,
  );
}

export type DelegationDirective =
  | {
      kind: 'delegate';
      handle: string;
      targetPubkey: string;
      task: string;
    }
  | {
      kind: 'permission';
      audience: 'admin' | 'owner';
      task: string;
    };

export type DelegationDirectiveError =
  | { reason: 'ambiguous-handle' | 'unknown-handle'; handle: string }
  | { reason: 'too-many-directives' }
  | { reason: 'empty-task'; handle: string };

export type DelegationDirectiveParseResult = {
  directives: DelegationDirective[];
  errors: DelegationDirectiveError[];
};

export type DelegationRosterEntry = {
  handle: string;
  pubkey: string;
};

/** Parse top-level directive blocks while treating quotes and code as inert. */
export function parseDelegationDirectives(
  text: string,
  roster: readonly DelegationRosterEntry[],
): DelegationDirectiveParseResult {
  const matchesByHandle = new Map<string, DelegationRosterEntry[]>();
  for (const entry of roster) {
    if (!entry.handle.trim() || !pubkey(entry.pubkey)) continue;
    const key = entry.handle.trim().replace(/^@/, '').toLowerCase();
    const matches = matchesByHandle.get(key) ?? [];
    matches.push(entry);
    matchesByHandle.set(key, matches);
  }
  const blocks: Array<{ handle: string; lines: string[] }> = [];
  let active: { handle: string; lines: string[] } | undefined;
  let fenced = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      active = undefined;
      continue;
    }
    if (fenced || /^>/.test(trimmed)) {
      active = undefined;
      continue;
    }
    const match = /^@([A-Za-z0-9][A-Za-z0-9_.-]{0,63}):(?:\s*(.*))$/.exec(rawLine);
    if (match?.[1]) {
      active = { handle: match[1], lines: match[2]?.trim() ? [match[2].trim()] : [] };
      blocks.push(active);
      continue;
    }
    if (active && trimmed) active.lines.push(trimmed);
    if (!trimmed) active = undefined;
  }
  const directives: DelegationDirective[] = [];
  const errors: DelegationDirectiveError[] = [];
  if (blocks.length > MAX_DELEGATION_DIRECTIVES_PER_TURN) {
    errors.push({ reason: 'too-many-directives' });
  }
  for (const block of blocks.slice(0, MAX_DELEGATION_DIRECTIVES_PER_TURN)) {
    const task = block.lines.join('\n').trim().slice(0, MAX_DELEGATION_TASK_CHARS);
    if (!task) {
      errors.push({ reason: 'empty-task', handle: block.handle });
      continue;
    }
    const normalized = block.handle.toLowerCase();
    if (normalized === 'admin' || normalized === 'owner') {
      directives.push({ kind: 'permission', audience: normalized, task });
      continue;
    }
    const matches = matchesByHandle.get(normalized) ?? [];
    if (matches.length === 0) {
      errors.push({ reason: 'unknown-handle', handle: block.handle });
      continue;
    }
    if (matches.length !== 1) {
      errors.push({ reason: 'ambiguous-handle', handle: block.handle });
      continue;
    }
    directives.push({
      kind: 'delegate',
      handle: block.handle,
      targetPubkey: matches[0]!.pubkey,
      task,
    });
  }
  return { directives, errors };
}

export type DelegationAdmissionReason =
  | 'duplicate'
  | 'wrong-recipient'
  | 'sender-not-agent'
  | 'sender-not-member'
  | 'recipient-not-member'
  | 'principal-not-member'
  | 'access-denied'
  | 'target-offline'
  | 'target-incompatible'
  | 'cross-workspace'
  | 'expired'
  | 'over-depth'
  | 'over-turn-budget'
  | 'over-child-budget'
  | 'over-token-budget'
  | 'cycle'
  | 'duplicate-work-item'
  | 'duplicate-return'
  | 'invalid-return'
  | 'root-mismatch'
  | 'escalation-required';

export type DelegationAdmission =
  | { admitted: true; rootBudget: DelegationBudgetV1; turnOrdinal: number }
  | { admitted: false; reason: DelegationAdmissionReason };

function rootTurns(
  history: readonly ParsedDelegationTurn[],
  delegationId: string,
): ParsedDelegationTurn[] {
  return history.filter((turn) => turn.value.delegationId === delegationId);
}

/**
 * Pure graph/budget admission. Current identity, membership, presence, and
 * access facts are passed by the Body only after fresh relay reads.
 */
export function admitDelegationTurn(input: {
  turn: ParsedDelegationTurn;
  history: readonly ParsedDelegationTurn[];
  receipts?: readonly ParsedDelegationReceipt[];
  now: number;
  expectedRecipientPubkey: string;
  senderIsRegisteredAgent: boolean;
  senderRoomMember: boolean;
  senderWorkspaceMember: boolean;
  recipientRoomMember: boolean;
  recipientWorkspaceMember: boolean;
  principalRoomMember: boolean;
  principalWorkspaceMember: boolean;
  rootAuthorized: boolean;
  escalationAuthorized: boolean;
  accessPermitted: boolean;
  targetOnline: boolean;
  targetSupportsDelegationV1: boolean;
}): DelegationAdmission {
  const turn = input.turn.value;
  if (input.history.some((candidate) => candidate.event.id === input.turn.event.id)) {
    return { admitted: false, reason: 'duplicate' };
  }
  if (turn.toAgentPubkey !== input.expectedRecipientPubkey)
    return { admitted: false, reason: 'wrong-recipient' };
  if (!input.senderIsRegisteredAgent) return { admitted: false, reason: 'sender-not-agent' };
  if (!input.senderRoomMember) return { admitted: false, reason: 'sender-not-member' };
  if (!input.senderWorkspaceMember) return { admitted: false, reason: 'sender-not-member' };
  if (!input.recipientRoomMember) return { admitted: false, reason: 'recipient-not-member' };
  if (!input.recipientWorkspaceMember) return { admitted: false, reason: 'recipient-not-member' };
  if (!input.principalRoomMember) return { admitted: false, reason: 'principal-not-member' };
  if (!input.principalWorkspaceMember) return { admitted: false, reason: 'principal-not-member' };
  if (!input.rootAuthorized) return { admitted: false, reason: 'root-mismatch' };
  if (!input.accessPermitted) return { admitted: false, reason: 'access-denied' };
  if (!input.targetOnline) return { admitted: false, reason: 'target-offline' };
  if (!input.targetSupportsDelegationV1) return { admitted: false, reason: 'target-incompatible' };
  if (input.now > turn.budget.deadlineAt) return { admitted: false, reason: 'expired' };
  if (turn.depth > turn.budget.maxDepth + (turn.phase === 'return' ? 1 : 0)) {
    return { admitted: false, reason: 'over-depth' };
  }
  const ungrantableBudgetShape =
    turn.budget.maxDepth > DEFAULT_DELEGATION_MAX_DEPTH ||
    turn.budget.maxChildren > DEFAULT_DELEGATION_MAX_CHILDREN ||
    turn.budget.deadlineAt - turn.createdAt > DEFAULT_DELEGATION_DEADLINE_SECONDS;
  const exceedsDefault = turn.budget.maxAgentTurns > DEFAULT_DELEGATION_MAX_AGENT_TURNS;
  if (
    ungrantableBudgetShape ||
    (exceedsDefault && !turn.escalationGrantEventId) ||
    (turn.escalationGrantEventId &&
      (!input.escalationAuthorized || turn.phase !== 'assign' || turn.depth !== 1))
  ) {
    return { admitted: false, reason: 'escalation-required' };
  }

  const graph = rootTurns(input.history, turn.delegationId);
  if (
    graph.some(
      (candidate) =>
        candidate.value.workItemId === turn.workItemId && candidate.value.phase === turn.phase,
    )
  ) {
    return {
      admitted: false,
      reason: turn.phase === 'return' ? 'duplicate-return' : 'duplicate-work-item',
    };
  }
  const root = graph[0];
  if (root) {
    if (turn.phase === 'assign' && turn.depth === 1) {
      return { admitted: false, reason: 'root-mismatch' };
    }
    if (
      root.value.rootEventId !== turn.rootEventId ||
      root.value.roomId !== turn.roomId ||
      root.value.workspaceId !== turn.workspaceId ||
      root.value.principalPubkey !== turn.principalPubkey ||
      root.value.budget.deadlineAt !== turn.budget.deadlineAt
    ) {
      return { admitted: false, reason: 'root-mismatch' };
    }
  }
  const rootBudget = root?.value.budget ?? turn.budget;
  if (graph.length + 1 > rootBudget.maxAgentTurns) {
    return { admitted: false, reason: 'over-turn-budget' };
  }
  if (turn.phase === 'assign') {
    if (turn.path.includes(turn.toAgentPubkey)) return { admitted: false, reason: 'cycle' };
    if (turn.parentWorkItemId) {
      const parent = graph.find(
        (candidate) =>
          candidate.value.workItemId === turn.parentWorkItemId &&
          candidate.value.phase === 'assign' &&
          candidate.value.toAgentPubkey === turn.fromAgentPubkey,
      );
      if (!parent) return { admitted: false, reason: 'root-mismatch' };
      const siblings = graph.filter(
        (candidate) =>
          candidate.value.phase === 'assign' &&
          candidate.value.parentWorkItemId === turn.parentWorkItemId,
      );
      if (siblings.length + 1 > parent.value.budget.maxChildren) {
        return { admitted: false, reason: 'over-child-budget' };
      }
      const allocatedTurns = siblings.reduce(
        (sum, child) => sum + child.value.budget.maxAgentTurns,
        turn.budget.maxAgentTurns,
      );
      if (allocatedTurns > Math.max(0, parent.value.budget.maxAgentTurns - 1)) {
        return { admitted: false, reason: 'over-child-budget' };
      }
      const allocatedTokens = siblings.reduce(
        (sum, child) => sum + child.value.budget.reservedTokens,
        turn.budget.reservedTokens,
      );
      if (allocatedTokens > parent.value.budget.reservedTokens) {
        return { admitted: false, reason: 'over-token-budget' };
      }
    }
  } else {
    const assignment = graph.find(
      (candidate) =>
        candidate.value.phase === 'assign' &&
        candidate.value.workItemId === turn.parentWorkItemId &&
        candidate.value.toAgentPubkey === turn.fromAgentPubkey,
    );
    if (
      !assignment ||
      turn.toAgentPubkey !== assignment.value.fromAgentPubkey ||
      turn.path.length < 2 ||
      turn.path[turn.path.length - 2] !== turn.toAgentPubkey
    ) {
      return { admitted: false, reason: 'invalid-return' };
    }
    const alreadyReturned = graph.some(
      (candidate) =>
        candidate.value.phase === 'return' &&
        candidate.value.parentWorkItemId === turn.parentWorkItemId,
    );
    if (alreadyReturned) return { admitted: false, reason: 'duplicate-return' };
  }
  const terminalReceipt = (input.receipts ?? []).find(
    (receipt) =>
      receipt.value.delegationId === turn.delegationId &&
      receipt.value.workItemId === turn.workItemId &&
      ['complete', 'failed', 'refused', 'budget-exhausted'].includes(receipt.value.status),
  );
  if (terminalReceipt) return { admitted: false, reason: 'duplicate-work-item' };
  return { admitted: true, rootBudget, turnOrdinal: graph.length + 1 };
}
