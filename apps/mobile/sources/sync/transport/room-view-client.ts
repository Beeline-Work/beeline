import {
  RoomViewClient as LegacyRoomViewClient,
  RoomViewHttpError,
  type RoomViewClientOptions,
} from '@beeline/buzz-client';
import {
  readAgentDetailView,
  readAgentPairingClaimView,
  readChatListView,
  readCornerListView,
  readInviteView,
  readMessageSearchView,
  readRoomHistoryOutline,
  readRoomHistoryView,
  readRoomView,
  readWorkspaceListView,
  readWorkspaceMemberListView,
  readWorkspaceView,
  type SurfaceReader,
  type AgentDetailView,
  type AgentPairingClaimView,
  type ChatListView,
  type CornerListView,
  type InviteView,
  type MessageSearchView,
  type RoomHistoryOutline,
  type RoomHistoryView,
  type RoomView,
  type WorkspaceListView,
  type WorkspaceMemberListQuery,
  type WorkspaceMemberListView,
  type WorkspaceView,
} from '@beeline/api-contract/phone';
import {
  monolithSession,
  monolithResponseTiming,
  MonolithRequestTimeoutError,
  MONOLITH_REQUEST_TIMEOUT_MS,
} from '@/auth/monolith-session';
import { recordRoomReadNetworkTiming } from '@/buzz/room-open-trace';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { liveFrameEpoch } from './live-frame-epoch';

export { RoomViewHttpError };

/**
 * Identical GETs in flight at once share one request: every screen mounting
 * on the same open asks for the same Workspace, Room list or Room. A caller
 * that asks after the live socket delivered anything new starts its own read,
 * because the shared one may predate the change that frame announced.
 */
const readsInFlight = new Map<string, { promise: Promise<unknown>; epoch: number }>();

function shareRead<T>(key: string, start: () => Promise<T>): Promise<T> {
  const epoch = liveFrameEpoch();
  const shared = readsInFlight.get(key);
  if (shared && shared.epoch === epoch) return shared.promise as Promise<T>;
  const promise = start();
  const entry = { promise, epoch };
  readsInFlight.set(key, entry);
  const release = () => {
    if (readsInFlight.get(key) === entry) readsInFlight.delete(key);
  };
  promise.then(release, release);
  return promise;
}

/** A bounded deadline fired before the server answered the phone's read. */
export function isRoomViewTimeoutError(error: unknown): boolean {
  if (error instanceof MonolithRequestTimeoutError) return true;
  if (error instanceof RoomViewHttpError) {
    return error.code === 'timeout' || error.code === 'surface_request_timed_out';
  }
  return false;
}

type Guard<T> = SurfaceReader<T>;

/**
 * Room and history reads ask the server to leave out what the reader
 * rebuilds (`readScopedMessage`, packages/api-contract/src/phone-guards.ts);
 * an older server ignores the header and answers in full. Only the native
 * phone asks: in a browser the header costs a CORS preflight, and a server
 * rolled back past its allow-list would refuse the read outright.
 */
const COMPACT_ROOM_READ: Record<string, string> | undefined =
  typeof document === 'undefined' ? { 'x-beeline-view': 'compact' } : undefined;

class MonolithRoomViewClient {
  private readonly baseUrl = getBuzzRuntimeConfig().monolithUrl;

  workspaces(): Promise<WorkspaceListView> {
    return this.get('/v1/phone/workspaces', readWorkspaceListView);
  }
  workspace(id: string): Promise<WorkspaceView> {
    return this.get(`/v1/phone/workspaces/${encodeURIComponent(id)}`, readWorkspaceView);
  }
  workspaceMembers(
    id: string,
    query: WorkspaceMemberListQuery = {},
  ): Promise<WorkspaceMemberListView> {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.memberId) params.set('memberId', query.memberId);
    if (query.ownerId) params.set('ownerId', query.ownerId);
    if (query.kind) params.set('kind', query.kind);
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.get(
      `/v1/phone/workspaces/${encodeURIComponent(id)}/members${suffix}`,
      readWorkspaceMemberListView,
    );
  }
  agent(workspaceId: string, agentId: string, workCursor?: string): Promise<AgentDetailView> {
    return this.get(
      `/v1/phone/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}${workCursor ? `?workCursor=${encodeURIComponent(workCursor)}` : ''}`,
      readAgentDetailView,
    );
  }
  chats(id: string): Promise<ChatListView> {
    return this.get(`/v1/phone/workspaces/${encodeURIComponent(id)}/chats`, readChatListView);
  }
  room(id: string): Promise<RoomView> {
    return this.get(`/v1/phone/rooms/${encodeURIComponent(id)}`, readRoomView, undefined, COMPACT_ROOM_READ);
  }
  corners(
    id: string,
    options: { readonly archived?: boolean; readonly before?: string } = {},
  ): Promise<CornerListView> {
    const query = options.archived
      ? `?archived=1${options.before ? `&before=${encodeURIComponent(options.before)}` : ''}`
      : '';
    return this.get(
      `/v1/phone/rooms/${encodeURIComponent(id)}/corners${query}`,
      readCornerListView,
    );
  }
  history(id: string, before?: { createdAt: number; id: string }): Promise<RoomHistoryView> {
    const query = before ? `?before=${encodeURIComponent(`${before.createdAt},${before.id}`)}` : '';
    return this.get(
      `/v1/phone/rooms/${encodeURIComponent(id)}/history${query}`,
      readRoomHistoryView,
      undefined,
      COMPACT_ROOM_READ,
    );
  }
  historyAfter(id: string, messageId: string): Promise<RoomHistoryView> {
    return this.get(
      `/v1/phone/rooms/${encodeURIComponent(id)}/history?after=${encodeURIComponent(messageId)}`,
      readRoomHistoryView,
      undefined,
      COMPACT_ROOM_READ,
    );
  }
  historyAround(id: string, messageId: string): Promise<RoomHistoryView> {
    return this.get(
      `/v1/phone/rooms/${encodeURIComponent(id)}/history?around=${encodeURIComponent(messageId)}`,
      readRoomHistoryView,
      undefined,
      COMPACT_ROOM_READ,
    );
  }
  outline(id: string, timeZone: string): Promise<RoomHistoryOutline> {
    return this.get(
      `/v1/phone/rooms/${encodeURIComponent(id)}/outline?tz=${encodeURIComponent(timeZone)}`,
      readRoomHistoryOutline,
    );
  }
  searchMessages(
    workspaceId: string,
    query: string,
    before?: string,
    signal?: AbortSignal,
  ): Promise<MessageSearchView> {
    const params = new URLSearchParams({ q: query });
    if (before) params.set('before', before);
    return this.get(
      `/v1/phone/workspaces/${encodeURIComponent(workspaceId)}/search?${params.toString()}`,
      readMessageSearchView,
      signal,
    );
  }
  invite(token: string): Promise<InviteView> {
    return this.operation('resolveInvite', { token }, readInviteView);
  }
  claimAgentPairing(code: string): Promise<AgentPairingClaimView> {
    return this.operation('claimAgentPairing', { code }, readAgentPairingClaimView);
  }
  abandonAgentPairing(): Promise<never> {
    return Promise.reject(new Error('Pairing abandon is not available on the phone API'));
  }
  markRead(roomId: string, messageId: string): Promise<void> {
    return this.request(`/v1/phone/rooms/${encodeURIComponent(roomId)}/read`, 'POST', {
      messageId,
    }).then(() => undefined);
  }
  markUnread(roomId: string, messageId: string): Promise<void> {
    return this.request(`/v1/phone/rooms/${encodeURIComponent(roomId)}/unread`, 'POST', {
      messageId,
    }).then(() => undefined);
  }

  private get<T>(
    path: string,
    guard: Guard<T>,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<T> {
    // A read its caller can cancel (search) is never shared.
    if (signal) return this.checked(path, 'GET', guard, undefined, signal);
    return shareRead(path, () => this.checked(path, 'GET', guard, undefined, undefined, headers));
  }
  private operation<T>(name: string, input: unknown, guard: Guard<T>): Promise<T> {
    return this.checked(`/v1/phone/operations/${name}`, 'POST', guard, input);
  }
  private async checked<T>(
    path: string,
    method: 'GET' | 'POST',
    guard: Guard<T>,
    body?: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<T> {
    // The session's deadline ends at the response headers. A body that
    // stalls after them would leave the read pending forever, so one deadline
    // covers the headers and the body together.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MONOLITH_REQUEST_TIMEOUT_MS);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort);
    if (signal?.aborted) controller.abort();
    try {
      const response = await this.request(path, method, body, controller.signal, headers);
      const value = await untilAborted(response.json() as Promise<unknown>, controller.signal);
      const projected = guard(value);
      if (projected === null) throw new RoomViewHttpError(502, 'invalid_surface_response');
      return projected;
    } catch (error) {
      if (timedOut) {
        // The answer stalled after its headers: the connection under it is
        // presumed dead, so the next request goes elsewhere.
        monolithSession.noteStalled(`${this.baseUrl}${path}`);
        throw new RoomViewHttpError(0, 'timeout');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<Response> {
    // The phone API carries room/workspace reads and small writes only; media
    // uploads go straight through the session and stay unbounded.
    const response = await monolithSession
      .fetch(
        `${this.baseUrl}${path}`,
        {
          method,
          ...(signal ? { signal } : {}),
          ...(body === undefined
            ? headers
              ? { headers }
              : {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        },
        // Reads, read marks and invite lookups repeat safely on a fresh
        // connection; claiming a pairing code does not.
        {
          timeoutMs: MONOLITH_REQUEST_TIMEOUT_MS,
          idempotent: !path.endsWith('/operations/claimAgentPairing'),
        },
      )
      .catch((error: unknown) => {
        if (error instanceof MonolithRequestTimeoutError) throw new RoomViewHttpError(0, 'timeout');
        throw error;
      });
    if (!response.ok) {
      let code = 'request_failed';
      try {
        const json = response.json() as Promise<{ error?: unknown }>;
        const value = signal ? await untilAborted(json, signal) : await json;
        if (typeof value.error === 'string') code = value.error;
      } catch {}
      throw new RoomViewHttpError(response.status, code);
    }
    const roomMatch = /^\/v1\/phone\/rooms\/([^/]+)$/.exec(path);
    if (roomMatch) {
      const timing = monolithResponseTiming(response);
      const serverTiming = /^app;dur=(\d+(?:\.\d+)?)$/.exec(
        response.headers.get('server-timing') ?? '',
      );
      if (timing && serverTiming) {
        const requestToFirstByteMs = timing.firstByteMs - timing.requestStartMs;
        const serverProcessingMs = Number(serverTiming[1]);
        if (requestToFirstByteMs >= serverProcessingMs &&
            requestToFirstByteMs < 15_000 && serverProcessingMs >= 0) {
          recordRoomReadNetworkTiming(decodeURIComponent(roomMatch[1]!), {
            requestToFirstByteMs,
            serverProcessingMs,
          });
        }
      }
    }
    return response;
  }
}

/** Reject with an AbortError once `signal` aborts, whatever `promise` does. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('The request was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** A push can begin this read before the Room identity/relay setup completes. */
export function readPushedMonolithRoom(roomId: string): Promise<RoomView> {
  return new MonolithRoomViewClient().room(roomId);
}

/** Stable read seam: OTA config chooses the monolith or untouched relay reader. */
export class RoomViewClient {
  private readonly implementation: LegacyRoomViewClient | MonolithRoomViewClient;
  constructor(options: RoomViewClientOptions) {
    this.implementation = getBuzzRuntimeConfig().monolithEnabled
      ? new MonolithRoomViewClient()
      : new LegacyRoomViewClient(options);
  }
  workspaces() {
    return this.implementation.workspaces();
  }
  workspace(id: string) {
    return this.implementation.workspace(id);
  }
  workspaceMembers(id: string, query?: WorkspaceMemberListQuery) {
    return this.implementation.workspaceMembers(id, query);
  }
  agent(workspaceId: string, agentId: string, workCursor?: string) {
    return this.implementation.agent(workspaceId, agentId, workCursor);
  }
  chats(id: string) {
    return this.implementation.chats(id);
  }
  room(id: string) {
    return this.implementation.room(id);
  }
  /** `before` is an archived page's `nextArchived` cursor. */
  corners(id: string, options?: { readonly archived?: boolean; readonly before?: string }) {
    return this.implementation.corners(id, options);
  }
  history(id: string, before?: { createdAt: number; id: string }) {
    return this.implementation.history(id, before);
  }
  historyAfter(id: string, messageId: string): Promise<RoomHistoryView> {
    return this.implementation instanceof MonolithRoomViewClient
      ? this.implementation.historyAfter(id, messageId)
      : Promise.reject(new Error('Forward history requires the monolith'));
  }
  historyAround(id: string, messageId: string): Promise<RoomHistoryView> {
    return this.implementation instanceof MonolithRoomViewClient
      ? this.implementation.historyAround(id, messageId)
      : Promise.reject(new Error('Targeted history requires the monolith'));
  }
  /** The whole-history outline exists only on the monolith; null elsewhere. */
  outline(id: string, timeZone: string): Promise<RoomHistoryOutline | null> {
    return this.implementation instanceof MonolithRoomViewClient
      ? this.implementation.outline(id, timeZone)
      : Promise.resolve(null);
  }
  /** Room list message search exists only on the monolith; null elsewhere. */
  searchMessages(
    workspaceId: string,
    query: string,
    before?: string,
    signal?: AbortSignal,
  ): Promise<MessageSearchView | null> {
    return this.implementation instanceof MonolithRoomViewClient
      ? this.implementation.searchMessages(workspaceId, query, before, signal)
      : Promise.resolve(null);
  }
  invite(token: string) {
    return this.implementation.invite(token);
  }
  claimAgentPairing(code: string) {
    return this.implementation.claimAgentPairing(code);
  }
  abandonAgentPairing(code: string) {
    return this.implementation.abandonAgentPairing(code);
  }
  markRead(roomId: string, messageId: string): Promise<void> {
    return this.implementation instanceof MonolithRoomViewClient
      ? this.implementation.markRead(roomId, messageId)
      : Promise.resolve();
  }
  markUnread(roomId: string, messageId: string): Promise<void> {
    return this.implementation instanceof MonolithRoomViewClient
      ? this.implementation.markUnread(roomId, messageId)
      : Promise.resolve();
  }
}
