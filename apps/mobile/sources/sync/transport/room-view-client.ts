import {
  RoomViewClient as LegacyRoomViewClient,
  RoomViewHttpError,
  type RoomViewClientOptions,
} from '@beeline/buzz-client';
import {
  isAgentDetailView,
  isAgentPairingClaimView,
  isChatListView,
  isCornerListView,
  isInviteView,
  isRoomHistoryView,
  isRoomView,
  isWorkspaceListView,
  isWorkspaceView,
  type AgentDetailView,
  type AgentPairingClaimView,
  type ChatListView,
  type CornerListView,
  type InviteView,
  type RoomHistoryView,
  type RoomView,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/api-contract/phone';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

export { RoomViewHttpError };

type Guard<T> = (value: unknown) => value is T;

class MonolithRoomViewClient {
  private readonly baseUrl = getBuzzRuntimeConfig().monolithUrl;

  workspaces(): Promise<WorkspaceListView> {
    return this.get('/v1/phone/workspaces', isWorkspaceListView);
  }
  workspace(id: string): Promise<WorkspaceView> {
    return this.get(`/v1/phone/workspaces/${encodeURIComponent(id)}`, isWorkspaceView);
  }
  agent(workspaceId: string, agentId: string): Promise<AgentDetailView> {
    return this.get(
      `/v1/phone/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
      isAgentDetailView,
    );
  }
  chats(id: string): Promise<ChatListView> {
    return this.get(`/v1/phone/workspaces/${encodeURIComponent(id)}/chats`, isChatListView);
  }
  room(id: string): Promise<RoomView> {
    return this.get(`/v1/phone/rooms/${encodeURIComponent(id)}`, isRoomView);
  }
  corners(id: string): Promise<CornerListView> {
    return this.get(`/v1/phone/rooms/${encodeURIComponent(id)}/corners`, isCornerListView);
  }
  history(id: string, before?: { createdAt: number; id: string }): Promise<RoomHistoryView> {
    const query = before ? `?before=${encodeURIComponent(`${before.createdAt},${before.id}`)}` : '';
    return this.get(`/v1/phone/rooms/${encodeURIComponent(id)}/history${query}`, isRoomHistoryView);
  }
  invite(token: string): Promise<InviteView> {
    return this.operation('resolveInvite', { token }, isInviteView);
  }
  claimAgentPairing(code: string): Promise<AgentPairingClaimView> {
    return this.operation('claimAgentPairing', { code }, isAgentPairingClaimView);
  }
  abandonAgentPairing(): Promise<never> {
    return Promise.reject(new Error('Pairing abandon is not available on the phone API'));
  }
  markRead(roomId: string, messageId: string): Promise<void> {
    return this.request(`/v1/phone/rooms/${encodeURIComponent(roomId)}/read`, 'POST', {
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
    if (!guard(value)) throw new RoomViewHttpError(502, 'invalid_surface_response');
    return value;
  }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    const response = await monolithSession.fetch(`${this.baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
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
  agent(workspaceId: string, agentId: string) {
    return this.implementation.agent(workspaceId, agentId);
  }
  chats(id: string) {
    return this.implementation.chats(id);
  }
  room(id: string) {
    return this.implementation.room(id);
  }
  corners(id: string) {
    return this.implementation.corners(id);
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
}
