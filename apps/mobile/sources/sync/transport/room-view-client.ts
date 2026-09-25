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
  type RoomHistoryView,
  type RoomView,
  type WorkspaceListView,
  type WorkspaceMemberListQuery,
  type WorkspaceMemberListView,
  type WorkspaceView,
} from '@beeline/api-contract/phone';
import {
  monolithSession,
  MonolithRequestTimeoutError,
  MONOLITH_REQUEST_TIMEOUT_MS,
} from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

export { RoomViewHttpError };

/** A bounded deadline fired before the server answered the phone's read. */
export function isRoomViewTimeoutError(error: unknown): boolean {
  if (error instanceof MonolithRequestTimeoutError) return true;
  if (error instanceof RoomViewHttpError) {
    return error.code === 'timeout' || error.code === 'surface_request_timed_out';
  }
  return false;
}

type Guard<T> = SurfaceReader<T>;

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
    return this.get(`/v1/phone/rooms/${encodeURIComponent(id)}`, readRoomView);
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

  private get<T>(path: string, guard: Guard<T>): Promise<T> {
    return this.checked(path, 'GET', guard);
  }
  private operation<T>(name: string, input: unknown, guard: Guard<T>): Promise<T> {
    return this.checked(`/v1/phone/operations/${name}`, 'POST', guard, input);
  }
  private async checked<T>(
    path: string,
    method: 'GET' | 'POST',
    guard: Guard<T>,
    body?: unknown,
  ): Promise<T> {
    const response = await this.request(path, method, body);
    const value = (await response.json()) as unknown;
    const projected = guard(value);
    if (projected === null) throw new RoomViewHttpError(502, 'invalid_surface_response');
    return projected;
  }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    // The phone API carries room/workspace reads and small writes only; media
    // uploads go straight through the session and stay unbounded.
    const response = await monolithSession
      .fetch(
        `${this.baseUrl}${path}`,
        {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        },
        { timeoutMs: MONOLITH_REQUEST_TIMEOUT_MS },
      )
      .catch((error: unknown) => {
        if (error instanceof MonolithRequestTimeoutError) throw new RoomViewHttpError(0, 'timeout');
        throw error;
      });
    if (!response.ok) {
      let code = 'request_failed';
      try {
        const value = (await response.json()) as { error?: unknown };
        if (typeof value.error === 'string') code = value.error;
      } catch {}
      throw new RoomViewHttpError(response.status, code);
    }
    return response;
  }
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
    return this.implementation.agent(workspaceId, agentId);
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
