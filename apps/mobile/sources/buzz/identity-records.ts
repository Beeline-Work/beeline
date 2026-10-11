import type {
  AgentDetailView,
  ChatListView,
  ChatListWorkspace,
  CornerListView,
  MessageBookmarkView,
  NeedsYouItemView,
  RoomView,
  RoomViewIdentity,
  RoomViewMember,
  RoomViewMessage,
  WorkspaceListView,
  WorkspaceView,
} from '@beeline/api-contract/phone';
import type { SurfaceCacheAddress } from '@beeline/buzz-client';
import { useEffect, useState } from 'react';
import { subscribeClientReset } from '@/sync/client-reset';

export type WorkspaceHeaderChange = { id: string; name: string; avatar?: string };

/**
 * The newest live identity of each person and agent, and the newest header of
 * each Workspace, keyed by id per relay and viewer. Server projections keep
 * the values they were read with; every surface selects these records over
 * them. A record applies only to a projection stored before it (`stamp`):
 * a projection read after the change already carries it.
 */
type Records = {
  readonly people: Map<string, { identity: RoomViewIdentity; stamp: number }>;
  readonly workspaces: Map<string, { header: WorkspaceHeaderChange; stamp: number }>;
};

const scopes = new Map<string, Records>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

subscribeClientReset(() => {
  scopes.clear();
  notify();
});

/** Re-render a surface that is not a registry entry (the open Room) when any record changes. */
export function useIdentityRecords(): number {
  const [current, setCurrent] = useState(version);
  useEffect(() => {
    const listener = () => setCurrent(version);
    listeners.add(listener);
    setCurrent(version);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return current;
}

export function identityScope(relayOrigin: string, viewerPubkey: string): string {
  return JSON.stringify([new URL(relayOrigin).origin, viewerPubkey]);
}

function records(scope: string): Records {
  let scoped = scopes.get(scope);
  if (!scoped) {
    scoped = { people: new Map(), workspaces: new Map() };
    scopes.set(scope, scoped);
  }
  return scoped;
}

export function recordPerson(scope: string, identity: RoomViewIdentity, stamp: number): void {
  records(scope).people.set(identity.pubkey, { identity, stamp });
  notify();
}

export function recordWorkspaceHeader(scope: string, header: WorkspaceHeaderChange, stamp: number): void {
  records(scope).workspaces.set(header.id, { header, stamp });
  notify();
}

/** Selects the records of one viewer newer than a projection stored at `stamp`. */
export class IdentitySelection {
  private readonly scoped: Records | undefined;

  constructor(scope: string, private readonly stamp: number) {
    this.scoped = scopes.get(scope);
  }

  get empty(): boolean {
    return !this.scoped || (this.scoped.people.size === 0 && this.scoped.workspaces.size === 0);
  }

  person<T extends RoomViewIdentity | undefined>(identity: T): T {
    if (!identity) return identity;
    const record = this.scoped?.people.get(identity.pubkey);
    if (!record || record.stamp <= this.stamp) return identity;
    const next = record.identity;
    if (identity.name === next.name && identity.handle === next.handle &&
        identity.avatar === next.avatar && identity.face === next.face)
      return identity;
    const { handle: _handle, avatar: _avatar, face: _face, ...rest } = identity;
    return {
      ...rest,
      name: next.name,
      ...(next.handle !== undefined ? { handle: next.handle } : {}),
      ...(next.avatar !== undefined ? { avatar: next.avatar } : {}),
      ...(next.face !== undefined ? { face: next.face } : {}),
    } as T;
  }

  workspace<T extends ChatListWorkspace>(workspace: T): T {
    const record = this.scoped?.workspaces.get(workspace.id);
    if (!record || record.stamp <= this.stamp) return workspace;
    const { name, avatar } = record.header;
    if (workspace.name === name && workspace.avatar === avatar) return workspace;
    const { avatar: _avatar, ...rest } = workspace;
    return { ...rest, name, ...(avatar !== undefined ? { avatar } : {}) } as unknown as T;
  }

  member<T extends RoomViewMember>(member: T): T {
    const identity = this.person(member.identity);
    return identity === member.identity ? member : { ...member, identity };
  }

  message(message: RoomViewMessage): RoomViewMessage {
    const author = this.person(message.author);
    const reactions = list(message.reactions, (reaction) => {
      const members = list(reaction.members, (member) => this.person(member));
      return members === reaction.members ? reaction : { ...reaction, members };
    });
    const permission = message.permission && fields(message.permission, {
      agent: this.person(message.permission.agent),
      requester: this.person(message.permission.requester),
      decider: this.person(message.permission.decider),
    });
    const grantRequest = message.grantRequest && fields(message.grantRequest, {
      agent: this.person(message.grantRequest.agent),
      owner: this.person(message.grantRequest.owner),
      requester: this.person(message.grantRequest.requester),
    });
    const squireApproval = message.squireApproval && fields(message.squireApproval, {
      agent: this.person(message.squireApproval.agent),
    });
    const connectorOffer = message.connectorOffer && fields(message.connectorOffer, {
      agent: this.person(message.connectorOffer.agent),
      addressee: this.person(message.connectorOffer.addressee),
      acceptedBy: this.person(message.connectorOffer.acceptedBy),
    });
    const choice = message.choice && fields(message.choice, {
      agent: this.person(message.choice.agent),
      requester: this.person(message.choice.requester),
      answeredBy: this.person(message.choice.answeredBy),
    });
    const targetBranch = message.targetBranch && fields(message.targetBranch, {
      agent: this.person(message.targetBranch.agent),
      requester: this.person(message.targetBranch.requester),
    });
    return fields(message, {
      author, reactions, permission, grantRequest, squireApproval, connectorOffer, choice, targetBranch,
    });
  }

  roomView(view: RoomView): RoomView {
    return fields(view, {
      messages: list(view.messages, (message) => this.message(message)),
      toolRows: list(view.toolRows, (message) => this.message(message)),
      briefing: list(view.briefing, (message) => this.message(message)),
      members: list(view.members, (member) => this.member(member)),
      viewer: this.member(view.viewer),
    });
  }

  workspaceView(view: WorkspaceView): WorkspaceView {
    return fields(view, {
      workspace: this.workspace(view.workspace),
      members: list(view.members, (member) => this.member(member)),
      agents: list(view.agents, (agent) => {
        const member = this.member(agent);
        const owner = this.person(agent.owner);
        return owner === agent.owner ? member : { ...member, owner };
      }),
      viewer: this.member(view.viewer),
    });
  }

  chatList(view: ChatListView): ChatListView {
    return fields(view, {
      workspace: this.workspace(view.workspace),
      viewer: this.person(view.viewer),
      chats: list(view.chats, (chat) => fields(chat, {
        latestMessage: chat.latestMessage && fields(chat.latestMessage, {
          author: this.person(chat.latestMessage.author),
        }),
        directMessage: chat.directMessage && fields(chat.directMessage, {
          peer: this.person(chat.directMessage.peer),
        }),
      })),
    });
  }

  workspaceList(view: WorkspaceListView): WorkspaceListView {
    return fields(view, {
      viewer: this.person(view.viewer),
      workspaces: list(view.workspaces, (workspace) => this.workspace(workspace)),
    });
  }

  agentDetail(view: AgentDetailView): AgentDetailView {
    return fields(view, { agent: this.member(view.agent), owner: this.person(view.owner) });
  }

  corners(view: CornerListView): CornerListView {
    return fields(view, {
      corners: list(view.corners, (corner) => fields(corner, {
        initiator: this.person(corner.initiator),
        agent: this.person(corner.agent),
        latestMessage: corner.latestMessage && fields(corner.latestMessage, {
          author: this.person(corner.latestMessage.author),
        }),
      })),
    });
  }

  needsYou(view: { items: readonly NeedsYouItemView[] }): { items: readonly NeedsYouItemView[] } {
    return fields(view, {
      items: list(view.items, (item) => fields(item, { author: this.person(item.author) })),
    });
  }

  bookmarks<T extends { bookmarks: readonly MessageBookmarkView[] }>(view: T): T {
    return fields(view, {
      bookmarks: list(view.bookmarks, (bookmark) => fields(bookmark, {
        author: this.person(bookmark.author),
      })),
    } as Partial<T>);
  }
}

/** Map a list, keeping the original array when no item changed. */
function list<T>(items: readonly T[], map: (item: T) => T): readonly T[];
function list<T>(items: readonly T[] | undefined, map: (item: T) => T): readonly T[] | undefined;
function list<T>(items: readonly T[] | undefined, map: (item: T) => T): readonly T[] | undefined {
  if (!items) return items;
  let changed = false;
  const next = items.map((item) => {
    const mapped = map(item);
    if (mapped !== item) changed = true;
    return mapped;
  });
  return changed ? next : items;
}

/** Replace the named fields that changed, keeping the original object otherwise. */
function fields<T extends object>(value: T, next: Partial<T>): T {
  let changed = false;
  for (const [key, field] of Object.entries(next))
    if ((value as Record<string, unknown>)[key] !== field) changed = true;
  return changed ? { ...value, ...next } : value;
}

/**
 * The projection a surface reads: the stored server value with this viewer's
 * newer identity and Workspace records selected over it, by endpoint type.
 */
export function selectIdentities(address: SurfaceCacheAddress, value: unknown, stamp: number): unknown {
  const selection = new IdentitySelection(identityScope(address.relayOrigin, address.viewerPubkey), stamp);
  if (selection.empty) return value;
  const endpoint = address.endpoint;
  if (endpoint === '/workspaces') return selection.workspaceList(value as WorkspaceListView);
  if (endpoint === '/workspace/:id') return selection.workspaceView(value as WorkspaceView);
  if (endpoint === '/workspace/:id/chats') return selection.chatList(value as ChatListView);
  if (endpoint === '/workspace/:id/agents/:agentId') return selection.agentDetail(value as AgentDetailView);
  if (endpoint === '/workspace/:id/needs-you')
    return selection.needsYou(value as { items: readonly NeedsYouItemView[] });
  if (endpoint === '/workspace/:id/bookmarks')
    return selection.bookmarks(value as { bookmarks: readonly MessageBookmarkView[] });
  if (endpoint === '/room/:id/corners') return selection.corners(value as CornerListView);
  if (endpoint.startsWith('/room/')) return selection.roomView(value as RoomView);
  return value;
}
