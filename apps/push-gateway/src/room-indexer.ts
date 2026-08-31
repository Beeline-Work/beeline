import {
  ROOM_VIEW_BRIEFING_LIMIT,
  ROOM_VIEW_AGENT_LIMIT,
  ROOM_VIEW_CHAT_LIMIT,
  ROOM_VIEW_MEMBER_LIMIT,
  ROOM_VIEW_WORKSPACE_LIMIT,
  directMessageChannelId,
  isAllowedAgentModelConfigCategory,
  type AgentPairingClaimView,
  type AgentDetailView,
  type ChatListItem,
  type ChatListView,
  type CornerListItem,
  type CornerListView,
  type InviteView,
  type RoomHistoryView,
  type RoomView,
  type RoomViewAgentTurn,
  type RoomViewMember,
  type RoomViewMessage,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/buzz-client';
import type { DatabaseQueryable } from './database.js';
import {
  AGENT_DETAIL_SQL,
  AGENT_PAIRING_ABANDON_SQL,
  AGENT_PAIRING_CLAIM_SQL,
  agentStateFilter,
  CHAT_LIST_SQL,
  CHAT_PREVIEW_LIMIT,
  CORNER_LIST_SQL,
  DURABLE_KINDS,
  HISTORY_EVENT_LIMIT,
  INVITE_SQL,
  RAW_EVENT_LIMIT,
  ROOM_PAINT_SQL,
  ROOM_SQL,
  WORKSPACE_LIST_SQL,
  WORKSPACE_SQL,
  profileFilter,
  roomFilters,
} from './room-indexer-sql.js';
import {
  cornerItem,
  cornerLifecycle,
  header,
  identity,
  integer,
  json,
  latestCornerPlan,
  projectEvent,
  projectedHistoryPage,
  projectedMessages,
  projectedRoomMessages,
  repositoryFromRows,
  repositoryResolutionFromRows,
  rowData,
  safeJson,
  text,
  viewer,
  workspaceItem,
  type IndexRow,
  type Json,
} from './room-indexer-projection.js';

export { CHAT_LIST_SQL, ROOM_PAINT_SQL } from './room-indexer-sql.js';
export { collapsePermissionCards } from './room-indexer-projection.js';

function paintRoom(rows: readonly IndexRow[], roomId: string): RoomView | null {
  const roomData = rowData(rows, 'room');
  if (!roomData) return null;
  const members = rows
    .filter((row) => row.section === 'member')
    .map((row) => {
      const data = json(row.data);
      const memberIdentity = identity(data);
      const presenceStatus = text(data.presenceStatus);
      return {
        identity: memberIdentity,
        role: data.role as RoomViewMember['role'],
        ...(memberIdentity.kind === 'agent' &&
        (presenceStatus === 'online' || presenceStatus === 'offline')
          ? {
              presence: {
                status: presenceStatus as 'online' | 'offline',
                observedAt: integer(data.presenceObservedAt),
                ...(text(data.presenceRoomId) ? { roomId: text(data.presenceRoomId) } : {}),
              },
            }
          : {}),
      };
    });
  const parentData = rowData(rows, 'parent');
  const repository = repositoryFromRows(rows);
  const repositoryResolution = repositoryResolutionFromRows(rows, repository);
  const directMessageData = json(roomData.directMessage);
  const directMessageParticipants = Array.isArray(directMessageData.participants)
    ? directMessageData.participants.filter(
        (participant): participant is string =>
          typeof participant === 'string' && /^[0-9a-f]{64}$/.test(participant),
      )
    : [];
  const directMessage =
    directMessageParticipants.length === 2 &&
    new Set(directMessageParticipants).size === 2 &&
    members.length === 2 &&
    directMessageParticipants.every((participant) =>
      members.some((member) => member.identity.pubkey === participant),
    ) &&
    directMessageChannelId(
      String(roomData.workspaceId ?? ''),
      directMessageParticipants[0]!,
      directMessageParticipants[1]!,
    ) === roomId
      ? { participants: directMessageParticipants as [string, string] }
      : undefined;
  const corners = rows
    .filter((row) => row.section === 'sibling')
    .map((row) => cornerItem(json(row.data)));
  const latestAgentTurns = rows
    .filter((row) => row.section === 'agent-turn')
    .flatMap((row): RoomViewAgentTurn[] => {
      const data = json(row.data);
      const requestId = text(data.requestId);
      const agentPubkey = text(data.agentPubkey);
      const status = text(data.status);
      if (
        !requestId ||
        !/^[0-9a-f]{64}$/.test(requestId) ||
        !agentPubkey ||
        !/^[0-9a-f]{64}$/.test(agentPubkey) ||
        (status !== 'working' && status !== 'complete' && status !== 'failed')
      ) {
        return [];
      }
      const generationId = text(data.generationId);
      return [
        {
          requestId,
          agentPubkey,
          status,
          createdAt: integer(data.createdAt),
          ...(generationId ? { generationId } : {}),
        },
      ];
    })
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || left.agentPubkey.localeCompare(right.agentPubkey),
    );
  const cornerPlan = parentData ? latestCornerPlan(rows, roomId) : undefined;
  return {
    room: header(roomData),
    messages: projectedRoomMessages(rows, roomId, latestAgentTurns),
    members,
    latestAgentTurns,
    viewer: viewer(roomData, members),
    ...(directMessage ? { directMessage } : {}),
    ...(parentData ? { parent: header(parentData) } : {}),
    briefing: projectedMessages(
      rows,
      'briefing',
      String(parentData?.id ?? roomId),
      ROOM_VIEW_BRIEFING_LIMIT,
    ),
    ...(cornerPlan ? { cornerPlan } : {}),
    ...(repository ? { repository } : {}),
    repositoryResolution,
    ...(parentData ? { cornerLifecycle: cornerLifecycle(roomData) } : {}),
    corners,
    watchFilters: roomFilters(
      roomId,
      String(roomData.workspaceId ?? ''),
      [
        ...(parentData ? [String(parentData.id ?? '')] : []),
        ...corners.map((item) => item.corner.id),
      ],
      members,
    ),
  };
}
export class RoomIndexer {
  constructor(private readonly database: DatabaseQueryable) {}

  async readWorkspaces(viewerPubkey: string): Promise<WorkspaceListView> {
    const rows = (
      await this.database.query<IndexRow>(WORKSPACE_LIST_SQL, [
        viewerPubkey,
        ROOM_VIEW_WORKSPACE_LIMIT + 1,
      ])
    ).rows;
    const allWorkspaces = rows
      .filter((row) => row.section === 'workspace')
      .map((row) => workspaceItem(json(row.data)))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    const workspaces = allWorkspaces.slice(0, ROOM_VIEW_WORKSPACE_LIMIT);
    return {
      workspaces,
      viewer: identity(rowData(rows, 'viewer') ?? { pubkey: viewerPubkey }),
      truncated: allWorkspaces.length > ROOM_VIEW_WORKSPACE_LIMIT,
      watchFilters: [
        { kinds: [9000, 9001, 9007, 9008], '#p': [viewerPubkey] },
        ...profileFilter([identity(rowData(rows, 'viewer') ?? { pubkey: viewerPubkey })]),
      ],
    };
  }

  async readWorkspace(workspaceId: string, viewerPubkey: string): Promise<WorkspaceView | null> {
    const rows = (
      await this.database.query<IndexRow>(WORKSPACE_SQL, [
        workspaceId,
        viewerPubkey,
        ROOM_VIEW_MEMBER_LIMIT,
        ROOM_VIEW_AGENT_LIMIT,
      ])
    ).rows;
    const workspaceData = rowData(rows, 'workspace');
    if (!workspaceData) return null;
    const roster = rows
      .filter((row) => row.section === 'member')
      .map((row) => {
        const data = json(row.data);
        const memberIdentity = identity(data);
        const presenceStatus = text(data.presenceStatus);
        return {
          identity: memberIdentity,
          role: data.role as RoomViewMember['role'],
          ...(memberIdentity.kind === 'agent' &&
          (presenceStatus === 'online' || presenceStatus === 'offline')
            ? {
                presence: {
                  status: presenceStatus as 'online' | 'offline',
                  observedAt: integer(data.presenceObservedAt) * 1_000,
                  ...(text(data.presenceRoomId) ? { roomId: text(data.presenceRoomId) } : {}),
                },
              }
            : {}),
          kindTotal: integer(data.kindTotal),
        };
      });
    const allMembers = roster.filter((member) => member.identity.kind === 'human');
    const allAgents = roster.filter((member) => member.identity.kind === 'agent');
    const members = allMembers.slice(0, ROOM_VIEW_MEMBER_LIMIT);
    const agents = allAgents.slice(0, ROOM_VIEW_AGENT_LIMIT);
    const item = workspaceItem(workspaceData);
    const currentViewer = roster.find((member) => member.identity.pubkey === viewerPubkey);
    const role = item.role;
    return {
      workspace: {
        ...item,
        ...(text(workspaceData.about) ? { about: text(workspaceData.about) } : {}),
        createdAt: integer(workspaceData.createdAt),
      },
      ...(role === 'owner' || role === 'admin'
        ? { managerSettings: { visibility: item.visibility } }
        : {}),
      members,
      agents,
      membersTruncated: (allMembers[0]?.kindTotal ?? allMembers.length) > ROOM_VIEW_MEMBER_LIMIT,
      agentsTruncated: (allAgents[0]?.kindTotal ?? allAgents.length) > ROOM_VIEW_AGENT_LIMIT,
      viewer: {
        identity: currentViewer?.identity ?? identity({ pubkey: viewerPubkey }),
        role,
        permissions: { send: true, manage: role === 'owner' || role === 'admin' },
      },
      watchFilters: [
        { kinds: [...DURABLE_KINDS], '#h': [workspaceId] },
        ...profileFilter(roster.map((member) => member.identity)),
        ...agentStateFilter(agents.map((member) => member.identity)),
      ],
    };
  }

  async readAgent(
    workspaceId: string,
    agentPubkey: string,
    viewerPubkey: string,
  ): Promise<AgentDetailView | null> {
    const rows = (
      await this.database.query<IndexRow>(AGENT_DETAIL_SQL, [
        workspaceId,
        agentPubkey,
        viewerPubkey,
      ])
    ).rows;
    const agentData = rowData(rows, 'agent');
    if (!agentData) return null;
    const catalog = safeJson(text(rowData(rows, 'catalog')?.content) ?? '') ?? {};
    const config = safeJson(text(rowData(rows, 'config')?.content) ?? '') ?? {};
    const soulContent = safeJson(text(rowData(rows, 'soul')?.content) ?? '') ?? {};
    const soulName = text(soulContent.name);
    const soulInstructions =
      text(soulContent.soul) ??
      [
        text(soulContent.personality) ? `Personality: ${text(soulContent.personality)}` : undefined,
        text(soulContent.intent) ? `Intent: ${text(soulContent.intent)}` : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n\n');
    const soulAvatarSeed = text(soulContent.avatarSeed);
    const soulAvatar = text(soulContent.avatar);
    const safeSoulAvatar = soulAvatar && /^https?:\/\//i.test(soulAvatar) ? soulAvatar : undefined;
    const soul =
      soulName && soulInstructions && soulAvatarSeed
        ? {
            name: soulName,
            instructions: soulInstructions,
            avatarSeed: soulAvatarSeed,
            ...(safeSoulAvatar ? { avatar: safeSoulAvatar } : {}),
          }
        : undefined;
    const options = Array.isArray(catalog.options)
      ? catalog.options.flatMap((candidate) => {
          const option = json(candidate);
          const id = text(option.id);
          const category = text(option.category);
          if (!id || !category || !isAllowedAgentModelConfigCategory(category)) return [];
          const choices = Array.isArray(option.options)
            ? option.options.flatMap((raw) => {
                const choice = json(raw);
                const choiceId = text(choice.id);
                return choiceId
                  ? [{ id: choiceId, ...(text(choice.name) ? { name: text(choice.name) } : {}) }]
                  : [];
              })
            : [];
          return [
            {
              id,
              category,
              ...(text(option.currentValue) ? { currentValue: text(option.currentValue) } : {}),
              options: choices,
            },
          ];
        })
      : [];
    const runtime = json(catalog.selection);
    const selected = config;
    const runtimeSelection = {
      ...(text(runtime.model) ? { model: text(runtime.model) } : {}),
      ...(text(runtime.effort) ? { effort: text(runtime.effort) } : {}),
    };
    const selectedSelection = {
      ...(text(selected.model) ? { model: text(selected.model) } : {}),
      ...(text(selected.effort) ? { effort: text(selected.effort) } : {}),
    };
    return {
      workspaceId,
      agent: {
        identity: identity({
          ...agentData,
          ...(soul?.avatar ? { avatar: soul.avatar } : {}),
        }),
        role: agentData.role === 'owner' || agentData.role === 'admin' ? agentData.role : 'member',
      },
      ...(soul ? { soul } : {}),
      catalog: options,
      ...(Object.keys(runtimeSelection).length ? { runtimeSelection } : {}),
      ...(Object.keys(selectedSelection).length ? { selected: selectedSelection } : {}),
      watchFilters: [
        { kinds: [0], authors: [agentPubkey] },
        { kinds: [9, 9000, 9001], '#h': [workspaceId], '#p': [agentPubkey] },
        // Parameterized agent overlays are indexed by their canonical d key,
        // not by their community h tag. All three records share this key.
        { kinds: [30078], '#d': [`${workspaceId}:${agentPubkey}`] },
      ],
    };
  }

  async readRoom(roomId: string, viewerPubkey: string): Promise<RoomView | null> {
    const rows = (
      await this.database.query<IndexRow>(ROOM_PAINT_SQL, [
        roomId,
        viewerPubkey,
        RAW_EVENT_LIMIT,
        ROOM_VIEW_BRIEFING_LIMIT * 4,
      ])
    ).rows;
    return paintRoom(rows, roomId);
  }

  async readHistory(
    roomId: string,
    viewerPubkey: string,
    before?: { readonly createdAt: number; readonly id: string },
  ): Promise<RoomHistoryView | null> {
    const rows = (
      await this.database.query<IndexRow>(ROOM_SQL, [
        roomId,
        viewerPubkey,
        before?.createdAt ?? null,
        before?.id ?? '',
        HISTORY_EVENT_LIMIT,
      ])
    ).rows;
    if (!rowData(rows, 'room')) return null;
    const page = projectedHistoryPage(rows, roomId);
    return {
      roomId,
      messages: page.messages,
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    };
  }

  async readChats(workspaceId: string, viewerPubkey: string): Promise<ChatListView | null> {
    const rows = (
      await this.database.query<IndexRow>(CHAT_LIST_SQL, [
        workspaceId,
        viewerPubkey,
        ROOM_VIEW_CHAT_LIMIT + 1,
        CHAT_PREVIEW_LIMIT,
      ])
    ).rows;
    const workspaceData = rowData(rows, 'workspace');
    if (!workspaceData) return null;
    const previews = new Map<string, RoomViewMessage>();
    for (const row of rows.filter((candidate) => candidate.section === 'preview')) {
      const data = json(row.data);
      const roomId = String(data.roomId ?? '');
      const message = projectEvent(data, roomId);
      const current = previews.get(roomId);
      if (
        message?.presentation === 'message' &&
        (!current ||
          message.createdAt > current.createdAt ||
          (message.createdAt === current.createdAt && message.id < current.id))
      ) {
        previews.set(roomId, message);
      }
    }
    const allChats: ChatListItem[] = rows
      .filter((row) => row.section === 'chat')
      .map((row) => {
        const data = json(row.data);
        const room = header(data);
        const latest = previews.get(room.id);
        const agentState: 'needs-you' | 'working' | undefined =
          data.agentState === 'needs-you' || data.agentState === 'working'
            ? data.agentState
            : undefined;
        return {
          room,
          ...(latest
            ? {
                latestMessage: {
                  id: latest.id,
                  text: latest.text,
                  createdAt: latest.createdAt,
                  author: latest.author,
                },
              }
            : {}),
          memberCount: integer(data.memberCount),
          cornerCount: integer(data.cornerCount),
          unread: data.unread === true,
          ...(text(data.repositoryName) ? { repositoryName: text(data.repositoryName) } : {}),
          ...(agentState ? { agentState } : {}),
        };
      })
      .sort(
        (left, right) =>
          right.room.updatedAt - left.room.updatedAt || left.room.id.localeCompare(right.room.id),
      );
    const chats = allChats.slice(0, ROOM_VIEW_CHAT_LIMIT);
    const visibleRoomIds = new Set(chats.map((chat) => chat.room.id));
    const cornerIds = rows
      .filter((row) => row.section === 'corner-watch')
      .map((row) => json(row.data))
      .filter((data) => visibleRoomIds.has(String(data.parentId ?? '')))
      .map((data) => String(data.id ?? ''))
      .filter(Boolean);
    const roomAndCornerIds = [workspaceId, ...chats.map((chat) => chat.room.id), ...cornerIds];
    const viewerData = rowData(rows, 'viewer') ?? { pubkey: viewerPubkey };
    return {
      workspace: workspaceItem(workspaceData),
      chats,
      viewer: identity(viewerData),
      truncated: allChats.length > ROOM_VIEW_CHAT_LIMIT,
      watchFilters: [
        { kinds: [9000, 9001], '#p': [viewerPubkey] },
        { kinds: [...DURABLE_KINDS], '#h': roomAndCornerIds },
        ...(cornerIds.length ? [{ kinds: [39000, 39001, 39002], '#d': cornerIds }] : []),
        ...profileFilter([
          identity(viewerData),
          ...chats.flatMap((chat) => (chat.latestMessage ? [chat.latestMessage.author] : [])),
        ]),
      ],
    };
  }

  async readInvite(tokenHash: string, _readerPubkey?: string): Promise<InviteView | null> {
    const rows = (await this.database.query<IndexRow>(INVITE_SQL, [tokenHash])).rows;
    const data = rowData(rows, 'invite');
    if (!data) return null;
    return {
      name: text(data.name) ?? 'WORKSPACE',
      ...(text(data.avatar) ? { avatar: text(data.avatar) } : {}),
      expiresAt: integer(data.expiresAt),
    };
  }

  async claimAgentPairing(
    tokenHash: string,
    agentPubkey: string,
    inheritInviterRooms = false,
  ): Promise<AgentPairingClaimView | null> {
    const result = await this.database.query<{
      workspace_id: string;
      paired_by: string;
      joined: boolean;
      attached_room_ids: string[];
    }>(AGENT_PAIRING_CLAIM_SQL, [tokenHash, agentPubkey, inheritInviterRooms]);
    const claim = result.rows[0];
    if (!claim) return null;
    return {
      workspaceId: claim.workspace_id,
      pairedBy: claim.paired_by,
      joined: claim.joined,
      attachedRoomIds: claim.attached_room_ids,
    };
  }

  async abandonAgentPairing(tokenHash: string, agentPubkey: string): Promise<boolean> {
    const result = await this.database.query<{ abandoned: boolean }>(AGENT_PAIRING_ABANDON_SQL, [
      tokenHash,
      agentPubkey,
    ]);
    return result.rows[0]?.abandoned === true;
  }

  async readCorners(roomId: string, viewerPubkey: string): Promise<CornerListView | null> {
    const rows = (
      await this.database.query<IndexRow>(CORNER_LIST_SQL, [
        roomId,
        viewerPubkey,
        CHAT_PREVIEW_LIMIT,
      ])
    ).rows;
    const roomData = rowData(rows, 'room');
    if (!roomData) return null;
    const previews = new Map<string, RoomViewMessage>();
    for (const row of rows.filter((candidate) => candidate.section === 'preview')) {
      const data = json(row.data);
      const cornerId = String(data.roomId ?? '');
      const message = projectEvent(data, cornerId);
      if (message?.presentation === 'message' && !previews.has(cornerId))
        previews.set(cornerId, message);
    }
    const corners: CornerListItem[] = rows
      .filter((row) => row.section === 'corner')
      .map((row) => {
        const data = json(row.data);
        const id = String(data.id ?? '');
        return cornerItem(data, previews.get(id));
      });
    return {
      room: header(roomData),
      corners,
      viewer: {
        identity: identity({ pubkey: roomData.viewerPubkey }),
        role: (roomData.viewerRole === 'owner' || roomData.viewerRole === 'admin'
          ? roomData.viewerRole
          : 'member') as 'owner' | 'admin' | 'member',
        permissions: {
          send: roomData.archived !== true,
          manage: roomData.viewerRole === 'owner' || roomData.viewerRole === 'admin',
        },
      },
      watchFilters: [
        {
          kinds: [...DURABLE_KINDS],
          '#h': [
            String(roomData.workspaceId ?? ''),
            roomId,
            ...corners.map((item) => item.corner.id),
          ],
        },
        ...profileFilter(corners.flatMap((item) => (item.agent ? [item.agent] : []))),
      ],
    };
  }
}
