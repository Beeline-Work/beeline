import { createHash } from 'node:crypto';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { MAX_MISSION_RESERVED_TOKENS } from './permission-request.js';
import type { Identity } from './types.js';

export const SCHEDULED_TURN_TAG = 'buzz-scheduled-turn';
const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

export type ScheduledTurnStatus = 'queued' | 'working' | 'complete' | 'failed' | 'skipped';

export interface ScheduledTurnReceiptV1 {
  version: 1;
  workspaceId: string;
  roomId: string;
  agentPubkey: string;
  principalPubkey: string;
  scheduleId: string;
  revision: number;
  runId: string;
  nominalAt: number;
  status: ScheduledTurnStatus;
  at: number;
  reservedTokens: number;
  reason?: string;
}

export interface ParsedScheduledTurnReceipt {
  event: NostrEvent;
  value: ScheduledTurnReceiptV1;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : undefined;
}

function uniqueTag(event: NostrEvent, name: string): string | undefined {
  const matches = event.tags.filter((candidate) => candidate[0] === name);
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function parseReceiptValue(value: unknown): ScheduledTurnReceiptV1 | undefined {
  const input = object(value);
  const reason =
    typeof input?.reason === 'string' && input.reason.trim() && input.reason.length <= 600
      ? input.reason.trim()
      : undefined;
  if (
    !input ||
    input.version !== 1 ||
    typeof input.workspaceId !== 'string' ||
    !SAFE_ID.test(input.workspaceId) ||
    typeof input.roomId !== 'string' ||
    !SAFE_ID.test(input.roomId) ||
    typeof input.agentPubkey !== 'string' ||
    !HEX_64.test(input.agentPubkey) ||
    typeof input.principalPubkey !== 'string' ||
    !HEX_64.test(input.principalPubkey) ||
    typeof input.scheduleId !== 'string' ||
    !SAFE_ID.test(input.scheduleId) ||
    integer(input.revision, 1) === undefined ||
    typeof input.runId !== 'string' ||
    !/^wsr_[0-9a-f]{64}$/.test(input.runId) ||
    integer(input.nominalAt) === undefined ||
    !['queued', 'working', 'complete', 'failed', 'skipped'].includes(String(input.status)) ||
    integer(input.at) === undefined ||
    integer(input.reservedTokens, 0, MAX_MISSION_RESERVED_TOKENS) === undefined ||
    (input.reason !== undefined && !reason)
  ) return undefined;
  return {
    version: 1,
    workspaceId: input.workspaceId,
    roomId: input.roomId,
    agentPubkey: input.agentPubkey,
    principalPubkey: input.principalPubkey,
    scheduleId: input.scheduleId,
    revision: input.revision as number,
    runId: input.runId,
    nominalAt: input.nominalAt as number,
    status: input.status as ScheduledTurnStatus,
    at: input.at as number,
    reservedTokens: input.reservedTokens as number,
    ...(reason ? { reason } : {}),
  };
}

export function deterministicScheduleRunId(scheduleId: string, revision: number, nominalAt: number): string {
  if (!SAFE_ID.test(scheduleId) || integer(revision, 1) === undefined || integer(nominalAt) === undefined) {
    throw new Error('invalid scheduled run identity');
  }
  return `wsr_${createHash('sha256').update(`buzz-work-run:v1:${scheduleId}:${revision}:${nominalAt}`).digest('hex')}`;
}

export function buildScheduledTurnReceipt(identity: Identity, input: ScheduledTurnReceiptV1): NostrEvent {
  const value = parseReceiptValue(input);
  if (!value || identity.publicKey !== value.agentPubkey || deterministicScheduleRunId(value.scheduleId, value.revision, value.nominalAt) !== value.runId) {
    throw new Error('invalid scheduled turn receipt');
  }
  return signEvent({
    pubkey: identity.publicKey,
    created_at: value.at,
    kind: 9,
    tags: [
      ['h', value.roomId], ['t', SCHEDULED_TURN_TAG], ['workspace', value.workspaceId],
      ['agent', value.agentPubkey], ['principal', value.principalPubkey],
      ['schedule', value.scheduleId], ['revision', String(value.revision)], ['run', value.runId],
      ['nominal', String(value.nominalAt)], ['status', value.status],
    ],
    content: JSON.stringify(value),
  }, identity.secretKey);
}

export function parseScheduledTurnReceipt(event: NostrEvent): ParsedScheduledTurnReceipt | undefined {
  if (event.kind !== 9 || event.content.length > 8_000 || !verifyEvent(event)) return undefined;
  let value: ScheduledTurnReceiptV1 | undefined;
  try { value = parseReceiptValue(JSON.parse(event.content)); } catch { return undefined; }
  if (
    !value || event.pubkey !== value.agentPubkey || event.created_at !== value.at ||
    deterministicScheduleRunId(value.scheduleId, value.revision, value.nominalAt) !== value.runId ||
    uniqueTag(event, 'h') !== value.roomId || uniqueTag(event, 't') !== SCHEDULED_TURN_TAG ||
    uniqueTag(event, 'workspace') !== value.workspaceId || uniqueTag(event, 'agent') !== value.agentPubkey ||
    uniqueTag(event, 'principal') !== value.principalPubkey || uniqueTag(event, 'schedule') !== value.scheduleId ||
    uniqueTag(event, 'revision') !== String(value.revision) || uniqueTag(event, 'run') !== value.runId ||
    uniqueTag(event, 'nominal') !== String(value.nominalAt) || uniqueTag(event, 'status') !== value.status
  ) return undefined;
  return { event, value };
}
