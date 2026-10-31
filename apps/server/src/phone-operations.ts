import { randomUUID } from 'node:crypto';
import {
  MESSAGE_SEARCH_QUERY_MAX_BYTES, PHONE_READ_OPERATIONS, messageSearchTerms,
} from '@beeline/api-contract/phone';
import { PHONE_OPERATION_NAMES, MessageSearchTooBroadError, parseArchivedCornerCursor, type PhoneService } from './phone-service.js';
import { recordOperatorFunctionEvent } from './operator-dashboard.js';
import { IdentityRateLimit, type PhoneReadLimits } from './phone-read-limit.js';
import { VoiceBudgetExceeded } from './voice-budget.js';
import type { ServerOptions } from './server.js';
import { ExpectedRefusalError } from './command-refusal.js';

export class PhoneOperationError extends ExpectedRefusalError {
  constructor(readonly status: number, readonly payload: Record<string, unknown>) {
    super(String(payload.error ?? payload.status ?? 'request failed'));
  }
}

const quiet = new Set<string>([
  ...PHONE_READ_OPERATIONS, 'reopenChat', 'updateRoomPushState',
  'markRead', 'markUnread', 'reportClientError', 'reportPageLoad',
  // These services publish their own precise changes.
  'voiceJoin', 'voiceLeave', 'voiceIdle', 'voiceResume',
  'saveAgentVoice', 'previewAgentVoice',
]);
const clientErrorLimit = new IdentityRateLimit('client-error', 12);
function refuse(status: number, error: string): never {
  throw new PhoneOperationError(status, { error });
}
function found<T>(result: T | null): T {
  if (result === null) refuse(404, 'not_found');
  return result;
}
function required(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== 'string') refuse(400, `${key} is required`);
  return input[key];
}
function optional(input: Record<string, unknown>, key: string): string | undefined {
  if (input[key] === undefined) return undefined;
  return required(input, key);
}
function uuid(input: Record<string, unknown>, key: string): string {
  const value = required(input, key);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    refuse(400, `${key} is invalid`);
  return value;
}
function messageId(input: Record<string, unknown>): string {
  const value = required(input, 'messageId');
  if (!/^[0-9a-f]{64}$/.test(value)) refuse(400, 'invalid_message_id');
  return value;
}
function isIanaTimeZone(value: string): boolean {
  if (value !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
  catch { return false; }
}

/** One authenticated context for both transports; no operation is reimplemented per transport. */
export function createPhoneOperationDispatcher(
  options: ServerOptions,
  readLimits: PhoneReadLimits,
  legacyOperation: PhoneService['execute'],
) {
  const execute = async (name: string, input: Record<string, unknown>, viewerId: string,
    invokeLegacy?: () => Promise<unknown>): Promise<unknown> => {
    const phone = options.phone;
    switch (name) {
      case 'readWorkspaces': return phone.readWorkspaces(viewerId);
      case 'readWorkspace': return found(await phone.readWorkspace(uuid(input, 'workspaceId'), viewerId));
      case 'readWorkspaceMembers': {
        const offset = input.offset;
        return found(await phone.readWorkspaceMembers(uuid(input, 'workspaceId'), viewerId, {
          ...(input.ownerId ? { ownerId: required(input, 'ownerId') } : {}),
          ...(input.memberId ? { memberId: required(input, 'memberId') } : {}),
          ...(input.q ? { q: required(input, 'q') } : {}),
          ...(input.kind === 'human' || input.kind === 'agent' ? { kind: input.kind } : {}),
          ...(Number.isSafeInteger(offset) && (offset as number) >= 0 ? { offset: offset as number } : {}),
        }));
      }
      case 'readChats': return found(await phone.readChats(uuid(input, 'workspaceId'), viewerId));
      case 'readAgent': return found(await phone.readAgent(uuid(input, 'workspaceId'), required(input, 'agentId'), viewerId, optional(input, 'workCursor')));
      case 'resolveMessageLink': return found(await phone.resolveMessageLink(messageId(input), viewerId));
      case 'searchMessages': {
        if (!readLimits.search.admit(viewerId)) refuse(429, 'too_many_requests');
        const query = required(input, 'query').trim();
        if (!query || Buffer.byteLength(query, 'utf8') > MESSAGE_SEARCH_QUERY_MAX_BYTES) refuse(400, 'invalid_query');
        if (!messageSearchTerms(query)) refuse(400, 'query_too_short');
        const before = optional(input, 'before');
        if (before !== undefined && !/^[0-9a-f]{64}$/.test(before)) refuse(400, 'invalid_cursor');
        try { return found(await phone.searchMessages(uuid(input, 'workspaceId'), viewerId, query, before)); }
        catch (error) {
          if (error instanceof MessageSearchTooBroadError) refuse(422, 'query_too_broad');
          throw error;
        }
      }
      case 'readRoom': return found(await phone.readRoom(uuid(input, 'roomId'), viewerId));
      case 'readHistory':
      case 'readHistoryAfter':
      case 'readHistoryAround': {
        if (!readLimits.history.admit(viewerId)) refuse(429, 'too_many_requests');
        const room = uuid(input, 'roomId');
        if (name === 'readHistoryAfter') return found(await phone.readHistoryAfter(room, viewerId, messageId(input)));
        if (name === 'readHistoryAround') return found(await phone.readHistoryAround(room, viewerId, messageId(input)));
        const before = input.before as { createdAt?: unknown; id?: unknown } | undefined;
        if (before !== undefined && (!before || typeof before !== 'object' ||
          typeof before.createdAt !== 'number' || !Number.isSafeInteger(before.createdAt) ||
          before.createdAt < 0 || typeof before.id !== 'string' || !/^[0-9a-f]{64}$/.test(before.id)))
          refuse(400, 'invalid_cursor');
        return found(await phone.readHistory(room, viewerId, before as { createdAt: number; id: string } | undefined));
      }
      case 'readHistoryOutline': {
        if (!readLimits.outline.admit(viewerId)) refuse(429, 'too_many_requests');
        const timeZone = required(input, 'timeZone');
        if (!isIanaTimeZone(timeZone)) refuse(400, 'invalid_time_zone');
        return found(await phone.readHistoryOutline(uuid(input, 'roomId'), viewerId, timeZone));
      }
      case 'readCorners': {
        const before = optional(input, 'before');
        const openBeforeRaw = optional(input, 'openBefore');
        const archivedBefore = parseArchivedCornerCursor(before ?? null);
        const openBefore = parseArchivedCornerCursor(openBeforeRaw ?? null);
        const archived = input.archived === true;
        if ((before !== undefined && !archivedBefore) || (openBeforeRaw !== undefined && !openBefore) ||
          (archived && openBeforeRaw !== undefined) || (!archived && before !== undefined)) refuse(400, 'invalid_cursor');
        return found(await phone.readCorners(uuid(input, 'roomId'), viewerId, false, archived, archivedBefore, openBefore));
      }
      case 'markRead': return phone.markRead(uuid(input, 'roomId'), required(input, 'messageId'), viewerId);
      case 'markUnread': return phone.markUnread(uuid(input, 'roomId'), required(input, 'messageId'), viewerId);
      case 'voiceCurrent':
      case 'voiceJoin':
      case 'voiceState':
      case 'voiceIdle':
      case 'voiceResume':
      case 'voiceLeave': {
        if (!options.voice) refuse(503, 'Voice mode is unavailable');
        const voice = options.voice;
        if (name === 'voiceCurrent') return voice.current(uuid(input, 'roomId'), viewerId);
        if (name === 'voiceJoin') {
          try { return await voice.join(uuid(input, 'roomId'), viewerId, optional(input, 'expectedCallId')); }
          catch (error) {
            if (error instanceof VoiceBudgetExceeded)
              throw new PhoneOperationError(429, { error: error.message, code: 'voice-daily-limit', budget: error.budget });
            throw error;
          }
        }
        const call = uuid(input, 'callId');
        if (name === 'voiceState') return voice.idleState(call, viewerId, undefined, optional(input, 'sessionId'));
        if (name === 'voiceIdle') return voice.idle(call, viewerId, optional(input, 'sessionId'));
        if (name === 'voiceResume') {
          await voice.resume(call, viewerId, required(input, 'sessionId')); return { resumed: true };
        }
        await voice.leave(call, viewerId, false, optional(input, 'sessionId')); return { left: true };
      }
      case 'readAgentVoices':
      case 'saveAgentVoice':
      case 'previewAgentVoice': {
        if (!options.voice) refuse(503, 'The Workspace voice provider is unavailable');
        const workspace = uuid(input, 'workspaceId'), agent = required(input, 'agentId');
        if (name === 'readAgentVoices') return options.voice.profiles.catalog(workspace, agent, viewerId, optional(input, 'roomId'));
        const voiceId = input.voiceId;
        if (typeof voiceId !== 'string' || voiceId.length > 128) refuse(400, 'Invalid voice selection');
        return name === 'saveAgentVoice' ? options.voice.profiles.save(workspace, agent, viewerId, voiceId)
          : options.voice.profiles.preview(workspace, agent, viewerId, voiceId);
      }
      case 'reportClientError': {
        if (!clientErrorLimit.admit(viewerId)) refuse(429, 'too_many_requests');
        const limits = { message: 2048, stack: 4096, platform: 32, platformVersion: 64, releaseSha: 128, runtimeVersion: 64, updateId: 64 };
        const nativeLimits = { device: 128, appVersion: 64, crashTimestamp: 32 };
        if (!['app', 'conversation', 'voice-join', 'voice-cleanup', 'native-crash'].includes(String(input.scope)) ||
          Object.entries(limits).some(([key, limit]) => typeof input[key] !== 'string' || (input[key] as string).length > limit) ||
          Object.entries(nativeLimits).some(([key, limit]) => input[key] !== undefined &&
            (typeof input[key] !== 'string' || (input[key] as string).length > limit)) || !input.message)
          refuse(400, 'invalid_observation');
        const clean = (value: unknown) => String(value).replace(/https?:\/\/[^\s)]+/gi, '[url]')
          .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[token]');
        console.warn('[client-error]', JSON.stringify({ identityId: viewerId, scope: input.scope,
          ...Object.fromEntries(Object.keys(limits).map(key => [key, clean(input[key])])),
          ...Object.fromEntries(Object.keys(nativeLimits).filter(key => input[key] !== undefined).map(key => [key, clean(input[key])])) }));
        return;
      }
      case 'reportPageLoad': {
        const duration = input.durationMs, network = input.network;
        const jsResponseDelay = network && typeof network === 'object'
          ? (network as { jsResponseDelayMs?: unknown }).jsResponseDelayMs : undefined;
        const validNetwork = network === undefined || (network !== null && typeof network === 'object' &&
          Number.isFinite((network as { requestToFirstByteMs?: unknown }).requestToFirstByteMs) &&
          Number.isFinite((network as { serverProcessingMs?: unknown }).serverProcessingMs) &&
          (network as { requestToFirstByteMs: number }).requestToFirstByteMs >= 0 &&
          (network as { requestToFirstByteMs: number }).requestToFirstByteMs <= 15_000 &&
          (network as { serverProcessingMs: number }).serverProcessingMs >= 0 &&
          (network as { serverProcessingMs: number }).serverProcessingMs <= (network as { requestToFirstByteMs: number }).requestToFirstByteMs);
        if (!Number.isInteger(duration) || (duration as number) < 0 || (duration as number) > 600_000 ||
          typeof input.failed !== 'boolean' || !validNetwork || (jsResponseDelay !== undefined &&
            (typeof jsResponseDelay !== 'number' || !Number.isFinite(jsResponseDelay) || jsResponseDelay < 0 || jsResponseDelay > 600_000)))
          refuse(400, 'invalid_observation');
        await recordOperatorFunctionEvent(options.database, 'page_load', duration as number, input.failed,
          network === undefined ? undefined : Math.round((network as { requestToFirstByteMs: number }).requestToFirstByteMs -
            (network as { serverProcessingMs: number }).serverProcessingMs), jsResponseDelay as number | undefined);
        return;
      }
      default: return invokeLegacy ? invokeLegacy()
        : legacyOperation.call(phone, name as never, input as never, viewerId);
    }
  };

  return async (name: string, input: Record<string, unknown>, viewerId: string, signal?: AbortSignal,
    invokeLegacy?: () => Promise<unknown>): Promise<unknown> => {
    if (!viewerId) refuse(401, 'phone_token_required');
    if (!PHONE_OPERATION_NAMES.has(name as never)) refuse(404, 'unknown_phone_operation');
    if (!input || typeof input !== 'object' || Array.isArray(input)) refuse(400, 'invalid_args');
    signal?.throwIfAborted();
    const startedAt = Date.now();
    // Let admitted writes settle atomically. Never race a transaction against socket closure.
    const result = await execute(name, input, viewerId, invokeLegacy);
    if ((name === 'sendRoomMessage' || name === 'sendRoomReply') && typeof input.roomId === 'string')
      void options.github?.onWebhook?.('beeline:human-message', { cornerId: input.roomId })
        .catch(error => console.error('[server] human-triggered merge recovery failed:', error));
    const roomId = typeof input.roomId === 'string' ? input.roomId
      : result && typeof (result as { roomId?: unknown }).roomId === 'string' ? (result as { roomId: string }).roomId : undefined;
    if (roomId && !quiet.has(name)) {
      const messageId = result && typeof (result as { messageId?: unknown }).messageId === 'string'
        ? (result as { messageId: string }).messageId : undefined;
      options.live.publish({ type: 'invalidate', roomId, reason: 'phone-write',
        ...(messageId ? { messageId } : {}),
        ...(messageId && (name === 'sendRoomMessage' || name === 'sendRoomReply')
          ? { trace: { id: randomUUID(), databaseAt: Date.now(), emittedAt: Date.now(), startedAt } } : {}),
      });
    }
    return result;
  };
}

export type PhoneOperationDispatcher = ReturnType<typeof createPhoneOperationDispatcher>;
