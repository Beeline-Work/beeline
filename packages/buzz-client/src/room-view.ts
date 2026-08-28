import { nip98AuthHeader } from '@beeline/nostr';
import type { AttachmentReference } from './attachment.js';
import type { ChangeReviewArtifactDescriptor, ChangeReviewFile } from './change-review.js';
import type { AgentModelConfigOption, AgentModelSelection, Identity } from './types.js';
import type { KnownMessageReference } from './reply-proof.js';
import {
  isAgentDetailView,
  isChatListView,
  isCornerListView,
  isInviteView,
  isRoomHistoryView,
  isRoomView,
  isWorkspaceListView,
  isWorkspaceView,
} from './surface-guards.js';

export const ROOM_VIEW_MESSAGE_LIMIT = 30;
export const ROOM_VIEW_BRIEFING_LIMIT = 10;
export const ROOM_VIEW_WORKSPACE_LIMIT = 50;
export const ROOM_VIEW_CHAT_LIMIT = 200;
export const ROOM_VIEW_MEMBER_LIMIT = 200;
export const ROOM_VIEW_AGENT_LIMIT = 200;
export const ROOM_VIEW_REQUEST_TIMEOUT_MS = 8_000;

/** Opaque relay filters supplied by the authoritative surface query. */
export type SurfaceWatchFilter = {
  readonly kinds?: readonly number[];
  readonly authors?: readonly string[];
  readonly '#h'?: readonly string[];
  readonly '#d'?: readonly string[];
  readonly '#p'?: readonly string[];
};

export type RoomViewIdentity = {
  readonly pubkey: string;
  readonly kind: 'human' | 'agent';
  readonly name: string;
  readonly handle?: string;
  readonly avatar?: string;
};

export type RoomViewMember = {
  readonly identity: RoomViewIdentity;
  readonly role: 'owner' | 'admin' | 'member';
  readonly presence?: {
    readonly status: 'online' | 'offline';
    readonly observedAt: number;
    readonly roomId?: string;
  };
};

export type RoomViewHeader = {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly about?: string;
  readonly avatar?: string;
  readonly visibility?: 'public' | 'invite-only';
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type RoomViewActivity = {
  readonly kind: 'thinking' | 'tool' | 'output' | 'summary';
  readonly title: string;
  readonly operation?: string;
  readonly status?: string;
  readonly thoughtMs?: number;
  readonly rollup?: Readonly<Record<string, number>>;
  readonly observed?: readonly {
    readonly verb: string;
    readonly target?: string;
    readonly result?: string;
  }[];
  readonly files?: readonly { readonly path: string; readonly status?: string }[];
  readonly plan?: {
    readonly objective?: string;
    readonly items: readonly {
      readonly step: string;
      readonly status: 'pending' | 'in_progress' | 'completed';
    }[];
  };
};

export type RoomViewMessage = {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly author: RoomViewIdentity;
  readonly presentation: 'message' | 'system' | 'activity' | 'card';
  /** Proof that this exact message belongs to this Room, for reply signing. */
  readonly reference?: KnownMessageReference;
  readonly liveTurnId?: string;
  readonly requestId?: string;
  readonly attachments?: readonly AttachmentReference[];
  readonly mentionPubkeys?: readonly string[];
  /** Same-Room proof returned by the indexer and passed unchanged to reply signing. */
  readonly reply?: {
    readonly channelId: string;
    readonly eventId: string;
    readonly rootId: string;
  };
  readonly activity?: readonly RoomViewActivity[];
  readonly durableFact?: 'failure' | 'merge' | 'action';
  readonly corner?: {
    readonly id: string;
    readonly status: 'open' | 'working' | 'waiting' | 'idle' | 'concluded' | 'closed';
  };
  readonly merge?: {
    readonly action: 'ready' | 'not-ready' | 'landed' | 'failed' | 'approval-ack';
    readonly repository?: string;
    readonly branch?: string;
    readonly tip?: string;
    readonly patchId?: string;
    readonly previewUrl?: string;
    readonly retry?: 'auto' | 'realigning' | 'blocked';
    readonly approvalId?: string;
    readonly decision?: 'accepted' | 'rejected';
    readonly state?: 'landing' | 'realigning' | 'realigned' | 'content-changed' | 'tip-moved';
    readonly rejectedTip?: string;
  };
  readonly permission?: {
    readonly permissionId: string;
    readonly requestId: string;
    readonly agent: RoomViewIdentity;
    readonly tool: string;
    readonly repository?: string;
    readonly purpose?: 'squire-spending';
    readonly status: 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';
    readonly cornerId?: string;
  };
  readonly targetBranch?: {
    readonly proposalId: string;
    readonly from: string;
    readonly to: string;
    readonly repository?: string;
    readonly agent?: RoomViewIdentity;
    readonly requester?: RoomViewIdentity;
  };
};

export type RoomViewer = {
  readonly identity: RoomViewIdentity;
  readonly role: 'owner' | 'admin' | 'member';
  readonly permissions: {
    readonly send: boolean;
    readonly manage: boolean;
  };
};

export type RoomDirectMessageView = {
  readonly participants: readonly [string, string];
};

/** Latest durable turn lifecycle fact for one Room agent. */
export type RoomViewAgentTurn = {
  readonly requestId: string;
  readonly agentPubkey: string;
  readonly status: 'working' | 'complete' | 'failed';
  /** Relay event time in Unix seconds. */
  readonly createdAt: number;
  readonly generationId?: string;
};

export type RoomView = {
  readonly room: RoomViewHeader;
  readonly messages: readonly RoomViewMessage[];
  readonly members: readonly RoomViewMember[];
  readonly latestAgentTurns: readonly RoomViewAgentTurn[];
  readonly viewer: RoomViewer;
  readonly directMessage?: RoomDirectMessageView;
  readonly parent?: RoomViewHeader;
  readonly briefing?: readonly RoomViewMessage[];
  readonly repository?: RoomRepositoryView;
  readonly review?: RoomReviewView;
  readonly corners: readonly CornerListItem[];
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type RoomHistoryView = {
  readonly roomId: string;
  readonly messages: readonly RoomViewMessage[];
  readonly nextBefore?: { readonly createdAt: number; readonly id: string };
};

/** Prompt-ready conversation rows supplied directly by the Room endpoint. */
export type AgentHistoryEntry = {
  readonly eventId: string;
  readonly channelId: string;
  readonly type: 'human-message' | 'agent-message';
  readonly author: {
    readonly pubkey: string;
    readonly kind: 'human' | 'agent';
    readonly label: string;
  };
  readonly body: string;
  readonly attachments: readonly AttachmentReference[];
  readonly createdAt: number;
  readonly provenance: 'relay-verified';
};

export type ChatListItem = {
  readonly room: RoomViewHeader;
  readonly latestMessage?: {
    readonly id: string;
    readonly text: string;
    readonly createdAt: number;
    readonly author: RoomViewIdentity;
  };
  readonly memberCount: number;
  readonly cornerCount: number;
  /** Server-owned, cross-device read state. Every accepted list response carries it. */
  readonly unread: boolean;
  readonly repositoryName?: string;
};

export type ChatListWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly visibility: 'public' | 'invite-only';
  readonly role: 'owner' | 'admin' | 'member';
  readonly updatedAt: number;
};

export type ChatListView = {
  readonly workspace: ChatListWorkspace;
  readonly chats: readonly ChatListItem[];
  readonly viewer: RoomViewIdentity;
  readonly truncated: boolean;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type WorkspaceListView = {
  readonly workspaces: readonly ChatListWorkspace[];
  readonly viewer: RoomViewIdentity;
  readonly truncated: boolean;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type WorkspaceView = {
  readonly workspace: ChatListWorkspace & {
    readonly about?: string;
    readonly createdAt: number;
  };
  readonly managerSettings?: {
    readonly visibility: 'public' | 'invite-only';
  };
  readonly members: readonly RoomViewMember[];
  readonly agents: readonly RoomViewMember[];
  readonly membersTruncated: boolean;
  readonly agentsTruncated: boolean;
  readonly viewer: RoomViewer;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type AgentDetailView = {
  readonly workspaceId: string;
  readonly agent: RoomViewMember;
  /**
   * Latest valid human-authored soul overlay. The indexed read exposes this so
   * a name-only edit can preserve the agent's existing instructions exactly.
   */
  readonly soul?: {
    readonly name: string;
    readonly instructions: string;
    readonly avatarSeed: string;
    readonly avatar?: string;
  };
  readonly catalog: readonly AgentModelConfigOption[];
  readonly runtimeSelection?: AgentModelSelection;
  readonly selected?: AgentModelSelection;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type InviteView = {
  readonly name: string;
  readonly avatar?: string;
  readonly expiresAt: number;
};

export type CornerListItem = {
  readonly corner: RoomViewHeader;
  readonly status: 'open' | 'working' | 'waiting' | 'idle' | 'concluded' | 'closed';
  readonly reason?: 'review' | 'question' | 'failure';
  readonly agent?: RoomViewIdentity;
  readonly latestMessage?: {
    readonly id: string;
    readonly text: string;
    readonly createdAt: number;
    readonly author: RoomViewIdentity;
  };
};

export type CornerListView = {
  readonly room: RoomViewHeader;
  readonly corners: readonly CornerListItem[];
  readonly viewer: RoomViewer;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type RoomRepositoryView = {
  readonly key: string;
  readonly name: string;
  readonly remote: string;
  readonly targetBranch: string;
  readonly githubInstallationId?: number;
  readonly githubEventsEnabled: boolean;
};

export type RoomReviewView = {
  readonly status: 'none' | 'not-ready' | 'ready';
  readonly reason?: string;
  readonly artifact?: ChangeReviewArtifactDescriptor;
  readonly files: readonly ChangeReviewFile[];
  readonly approvedBy: readonly RoomViewIdentity[];
};

export type RoomViewClientOptions = {
  readonly baseUrl: string;
  readonly identity: Pick<Identity, 'secretKey' | 'publicKey'>;
  readonly fetch?: typeof fetch;
  /** Diagnostic hook fired exactly once immediately before each physical fetch. */
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
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RoomViewClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
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

  private get<T>(path: string, guard: (value: unknown) => value is T): Promise<T> {
    return this.request(path, 'GET', guard);
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    guard: (value: unknown) => value is T,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
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
      const response = await this.fetchImpl(url, {
        method,
        signal: abort.signal,
        headers: {
          authorization: nip98AuthHeader(
            this.options.identity.secretKey,
            this.options.identity.publicKey,
            url,
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
        // Malformed/truncated JSON is a terminal contract failure. A body
        // transport failure remains an offline/network error so a screen may
        // honestly retain its last validated response.
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
