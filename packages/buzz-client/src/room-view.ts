import { nip98AuthHeader } from '@beeline/nostr';
import {
  ROOM_VIEW_REQUEST_TIMEOUT_MS,
  isAgentDetailView,
  isAgentPairingAbandonView,
  isAgentPairingClaimWireView,
  isChatListView,
  isCornerListView,
  isInviteView,
  isRoomHistoryView,
  isRoomView,
  isWorkspaceListView,
  isWorkspaceView,
  type AgentDetailView,
  type AgentPairingAbandonView,
  type AgentPairingClaimView,
  type ChatListView,
  type CornerListView,
  type InviteView,
  type RoomHistoryView,
  type RoomView,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/api-contract/phone';
import type { Identity } from './types.js';

export * from '@beeline/api-contract/phone';

const AGENT_PAIRING_ROOM_ROLLBACK_CAPABILITY = 'pairing-room-rollback';

export type RoomViewClientOptions = {
  readonly baseUrl: string;
  readonly publicOrigin?: string;
  readonly identity: Pick<Identity, 'secretKey' | 'publicKey'>;
  readonly fetch?: typeof fetch;
  readonly onPhysicalRequest?: (request: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
  }) => void;
};

export class RoomViewHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Room view request failed (${status} ${code})`);
    this.name = 'RoomViewHttpError';
  }
}

export class RoomViewClient {
  private readonly baseUrl: string;
  private readonly authorizationBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RoomViewClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.authorizationBaseUrl = options.publicOrigin?.replace(/\/$/, '') ?? this.baseUrl;
    this.fetchImpl = options.fetch ?? fetch;
  }

  workspaces(): Promise<WorkspaceListView> {
    return this.get('/workspaces', isWorkspaceListView);
  }

  workspace(workspaceId: string): Promise<WorkspaceView> {
    return this.get(`/workspace/${encodeURIComponent(workspaceId)}`, isWorkspaceView);
  }

  agent(workspaceId: string, agentPubkey: string): Promise<AgentDetailView> {
    return this.get(
      `/workspace/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentPubkey)}`,
      isAgentDetailView,
    );
  }

  chats(workspaceId: string): Promise<ChatListView> {
    return this.get(`/workspace/${encodeURIComponent(workspaceId)}/chats`, isChatListView);
  }

  room(roomId: string): Promise<RoomView> {
    return this.get(`/room/${encodeURIComponent(roomId)}`, isRoomView);
  }

  corners(roomId: string): Promise<CornerListView> {
    return this.get(`/room/${encodeURIComponent(roomId)}/corners`, isCornerListView);
  }

  history(
    roomId: string,
    before?: { readonly createdAt: number; readonly id: string },
  ): Promise<RoomHistoryView> {
    const query = before ? `?before=${encodeURIComponent(`${before.createdAt},${before.id}`)}` : '';
    return this.get(`/room/${encodeURIComponent(roomId)}/messages${query}`, isRoomHistoryView);
  }

  invite(token: string): Promise<InviteView> {
    return this.request('/invite/resolve', 'POST', isInviteView, { token });
  }

  claimAgentPairing(code: string): Promise<AgentPairingClaimView> {
    return this.request('/agent-pairing/claim', 'POST', isAgentPairingClaimWireView, {
      code,
      capabilities: [AGENT_PAIRING_ROOM_ROLLBACK_CAPABILITY],
    }).then((claim) => ({ ...claim, attachedRoomIds: claim.attachedRoomIds ?? [] }));
  }

  abandonAgentPairing(code: string): Promise<AgentPairingAbandonView> {
    return this.request('/agent-pairing/abandon', 'POST', isAgentPairingAbandonView, { code });
  }

  private get<T>(path: string, guard: (value: unknown) => value is T): Promise<T> {
    return this.request(path, 'GET', guard);
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    guard: (value: unknown) => value is T,
    body?: unknown,
  ): Promise<T> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new RoomViewHttpError(504, 'surface_request_timed_out'));
      }, ROOM_VIEW_REQUEST_TIMEOUT_MS);
    });
    const perform = async () => {
      this.options.onPhysicalRequest?.({ method, path });
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: abort.signal,
        headers: {
          authorization: nip98AuthHeader(
            this.options.identity.secretKey,
            this.options.identity.publicKey,
            `${this.authorizationBaseUrl}${path}`,
            method,
          ),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        let code = 'request_failed';
        try {
          const errorBody = (await response.json()) as { error?: unknown };
          if (typeof errorBody.error === 'string') code = errorBody.error;
        } catch {}
        throw new RoomViewHttpError(response.status, code);
      }
      let value: unknown;
      try {
        value = (await response.json()) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new RoomViewHttpError(502, 'invalid_surface_response');
        }
        throw error;
      }
      if (!guard(value)) throw new RoomViewHttpError(502, 'invalid_surface_response');
      return value;
    };
    try {
      return await Promise.race([perform(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
