import { isAgentAccessPolicy } from './agent-access.js';
import { ROOM_VIEW_AGENT_LIMIT, ROOM_VIEW_BRIEFING_LIMIT, ROOM_VIEW_CHAT_LIMIT, ROOM_VIEW_MEMBER_LIMIT, ROOM_VIEW_MESSAGE_LIMIT, ROOM_VIEW_TOOL_ROW_LIMIT, ROOM_VIEW_WORKSPACE_LIMIT, WORKSPACE_MEMBER_PAGE_SIZE, type AgentAccessView, type AgentComposerCommand, type AgentModelConfigOption, type AgentModelSelection, type AgentYoloView, type ChatListUnavailable, type ChatListView, type CornerLifecycleView, type CornerListItem, type CornerListView, type MessageSearchResult, type MessageSearchSnippetPart, type MessageSearchView, type RoomHistoryOutline, type RoomHistoryOutlineDay, type RoomHistoryView, type RoomRepositoryResolution, type RoomRepositoryView, type RoomView, type WorkspaceListView, type WorkspaceManagedRoomView, type WorkspaceMemberListView, type WorkspaceView } from './phone-types.js';
import { record, oneOf, integer, readList, githubUrl, nonempty, SHA1, field, readHeader, readIdentity, readIdentityOnly, hex64, uuid, requireList, httpUrl, readNewestList, readViewer, readMember, readWatchFilters, readPlan, readWorkspaceAgent, readWorkspaceMemberGrantView } from './phone-guards.js';
import { readCheck, readCornerBlocker, readLatest, readScopedMessage, readAgentTurn, readPendingAgentCommand, readRoomViewMessage, readWorkspace, readChat, readCornerSummary } from './phone-guards-read-choice-card.js';



function readCornerLifecycle(value: unknown): CornerLifecycleView | null {
  const item = record(value);
  if (!item) return null;
  const mergeQueue = record(item.mergeQueue);
  const checksSummary = record(item.checksSummary);
  const summaryStatus = oneOf(checksSummary?.status, ['passing', 'failing', 'pending', 'unknown']);
  const projectedSummary =
    checksSummary &&
    summaryStatus &&
    integer(checksSummary.total) &&
    integer(checksSummary.updatedAt)
      ? {
          status: summaryStatus,
          total: checksSummary.total,
          failing: Array.isArray(checksSummary.failing)
            ? checksSummary.failing.filter((entry): entry is string => typeof entry === 'string')
            : [],
          updatedAt: checksSummary.updatedAt,
          checks: readList(checksSummary.checks, readCheck, 200) ?? [],
        }
      : undefined;
  const pr = record(item.pr);
  const projectedPr =
    pr &&
    integer(pr.number) &&
    pr.number > 0 &&
    githubUrl(pr.url) &&
    nonempty(pr.title) &&
    nonempty(pr.targetBranch) &&
    typeof pr.headSha === 'string' &&
    SHA1.test(pr.headSha)
      ? {
          number: pr.number,
          url: pr.url,
          title: pr.title,
          targetBranch: pr.targetBranch,
          headSha: pr.headSha,
          ...field('mergeability', oneOf(pr.mergeability, ['clean', 'dirty', 'draft', 'unknown', 'other'])),
          ...field('baseSha', typeof pr.baseSha === 'string' ? pr.baseSha : undefined),
          ...field('mergedAt', typeof pr.mergedAt === 'string' ? pr.mergedAt : undefined),
          ...field('mergedBy', typeof pr.mergedBy === 'string' ? pr.mergedBy : undefined),
        }
      : undefined;
  return {
    lifecycle: oneOf(item.lifecycle, ['working', 'in-review', 'unknown', 'done']) ?? 'unknown',
    checks: oneOf(item.checks, ['passing', 'failing', 'pending', 'unknown']) ?? 'unknown',
    ...field('mergeQueue', mergeQueue && typeof mergeQueue.headSha === 'string' && SHA1.test(mergeQueue.headSha)
      ? { headSha: mergeQueue.headSha,
          ...field('combinedSha', typeof mergeQueue.combinedSha === 'string' && SHA1.test(mergeQueue.combinedSha)
            ? mergeQueue.combinedSha : undefined) } : undefined),
    ...field('branch', typeof item.branch === 'string' ? item.branch : undefined),
    ...field('outcome', oneOf(item.outcome, ['landed', 'abandoned'])),
    ...field('reason', typeof item.reason === 'string' ? item.reason : undefined),
    ...field('checksSummary', projectedSummary),
    ...field('pr', projectedPr),
  };
}


function readCorner(value: unknown): CornerListItem | null {
  const item = record(value);
  const corner = readHeader(item?.corner);
  const lifecycle = readCornerLifecycle(item?.lifecycle) ?? {
    lifecycle: 'unknown' as const,
    checks: 'unknown' as const,
  };
  if (
    !item ||
    !corner ||
    (item.state !== 'working' &&
      item.state !== 'waiting' &&
      item.state !== 'idle' &&
      item.state !== 'review' &&
      item.state !== 'archived')
  ) {
    return null;
  }
  const initiator = readIdentity(item.initiator);
  return {
    corner,
    lifecycle,
    state: item.state,
    ...field('stateAt', integer(item.stateAt) ? item.stateAt : undefined),
    ...field('closedAt', integer(item.closedAt) ? item.closedAt : undefined),
    ...field('reason', oneOf(item.reason, ['approve', 'connect', 'question'])),
    ...field('blocker', readCornerBlocker(item.blocker)),
    ...field('itemId', nonempty(item.itemId) ? item.itemId : undefined),
    ...field('initiator', initiator && initiator.kind === 'human' ? initiator : undefined),
    ...field('mine', item.mine === true ? (true as const) : undefined),
    ...field('agent', readIdentityOnly(item.agent)),
    ...field(
      'briefRevision',
      integer(item.briefRevision) && item.briefRevision > 0 ? item.briefRevision : undefined,
    ),
    ...field('latestMessage', readLatest(item.latestMessage)),
  };
}


function readRepository(value: unknown): RoomRepositoryView | null {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.key) ||
    !nonempty(item.name) ||
    !nonempty(item.remote) ||
    !nonempty(item.targetBranch) ||
    !integer(item.updatedAt) ||
    typeof item.githubEventsEnabled !== 'boolean'
  ) {
    return null;
  }
  return {
    key: item.key,
    name: item.name,
    remote: item.remote,
    targetBranch: item.targetBranch,
    updatedAt: item.updatedAt,
    githubEventsEnabled: item.githubEventsEnabled,
    ...field(
      'githubInstallationId',
      integer(item.githubInstallationId) ? item.githubInstallationId : undefined,
    ),
    ...field(
      'allowAutoMerge',
      typeof item.allowAutoMerge === 'boolean' ? item.allowAutoMerge : undefined,
    ),
  };
}


function readRepositoryResolution(value: unknown): RoomRepositoryResolution | undefined {
  return value === 'repository' || value === 'none' || value === 'unverified' ? value : undefined;
}


function readDirectMessage(
  value: unknown,
  viewerPubkey: string,
): { readonly participants: readonly [string, string] } | undefined {
  const item = record(value);
  if (!item || !Array.isArray(item.participants) || item.participants.length !== 2)
    return undefined;
  const left = item.participants[0];
  const right = item.participants[1];
  if (!hex64(left) || !hex64(right)) return undefined;
  if (left >= right || (left !== viewerPubkey && right !== viewerPubkey)) return undefined;
  return { participants: [left, right] };
}


export function readModelSelection(value: unknown): AgentModelSelection | undefined {
  const item = record(value);
  if (!item) return undefined;
  return {
    ...field('model', typeof item.model === 'string' ? item.model : undefined),
    ...field('effort', typeof item.effort === 'string' ? item.effort : undefined),
  };
}


export function readModelOption(value: unknown): AgentModelConfigOption | null {
  const item = record(value);
  if (!item || !nonempty(item.id) || !nonempty(item.category)) return null;
  const options = readList(item.options, (candidate) => {
    const option = record(candidate);
    if (!option || !nonempty(option.id)) return null;
    return {
      id: option.id,
      ...field('name', typeof option.name === 'string' ? option.name : undefined),
      ...field(
        'description',
        typeof option.description === 'string' ? option.description : undefined,
      ),
    };
  });
  if (!options) return null;
  return {
    id: item.id,
    category: item.category,
    options,
    ...field('currentValue', typeof item.currentValue === 'string' ? item.currentValue : undefined),
  };
}


export function readComposerCommand(value: unknown): AgentComposerCommand | null {
  const item = record(value);
  if (!item || !nonempty(item.name)) return null;
  return {
    name: item.name,
    ...field('description', nonempty(item.description) ? item.description : undefined),
    ...field('inputHint', nonempty(item.inputHint) ? item.inputHint : undefined),
  };
}


export function readAgentYolo(value: unknown): AgentYoloView | null {
  const item = record(value);
  const setBy = record(item?.setBy);
  if (!item || typeof item.enabled !== 'boolean' || typeof item.canChange !== 'boolean')
    return null;
  return {
    enabled: item.enabled,
    canChange: item.canChange,
    ...field('forcedOff', typeof item.forcedOff === 'boolean' ? item.forcedOff : undefined),
    ...field('setBy', setBy && typeof setBy.name === 'string' ? { name: setBy.name } : undefined),
    ...field('setAt', integer(item.setAt) ? item.setAt : undefined),
  };
}


export function readAgentAccess(value: unknown): AgentAccessView | null {
  const item = record(value);
  const owner = record(item?.owner);
  if (!item || !isAgentAccessPolicy(item.policy) || typeof item.canChange !== 'boolean')
    return null;
  return {
    policy: item.policy,
    canChange: item.canChange,
    ...field(
      'owner',
      owner && typeof owner.id === 'string' && typeof owner.name === 'string'
        ? {
            id: owner.id,
            name: owner.name,
            ...field('handle', typeof owner.handle === 'string' ? owner.handle : undefined),
          }
        : undefined,
    ),
  };
}


function readManagedRoom(value: unknown): WorkspaceManagedRoomView | null {
  const item = record(value);
  if (
    !item ||
    !uuid(item.id) ||
    typeof item.name !== 'string' ||
    (item.visibility !== 'public' && item.visibility !== 'invite-only') ||
    !integer(item.createdAt)
  ) {
    return null;
  }
  return {
    id: item.id,
    name: item.name,
    visibility: item.visibility,
    createdAt: item.createdAt,
  };
}


function readCornerBrief(value: unknown): NonNullable<RoomView['cornerBrief']> | null {
  const item = record(value);
  if (!item || !integer(item.revision) || item.revision < 1 || typeof item.spec !== 'string')
    return null;
  const attachments = requireList(item.attachments, (candidate) => {
    const file = record(candidate);
    if (
      !file ||
      typeof file.title !== 'string' ||
      typeof file.purpose !== 'string' ||
      typeof file.required !== 'boolean' ||
      !httpUrl(file.url)
    )
      return null;
    return { title: file.title, purpose: file.purpose, required: file.required, url: file.url };
  });
  if (!attachments) return null;
  const approval = record(item.approval);
  return {
    ...field('authorHandle', typeof item.authorHandle === 'string' ? item.authorHandle : undefined),
    revision: item.revision,
    spec: item.spec,
    attachments,
    ...field(
      'approval',
      approval &&
        hex64(approval.sourceMessageId) &&
        typeof approval.text === 'string' &&
        typeof approval.approverName === 'string'
        ? {
            sourceMessageId: approval.sourceMessageId,
            text: approval.text,
            approverName: approval.approverName,
          }
        : undefined,
    ),
  };
}


export function readRoomView(value: unknown): RoomView | null {
  const item = record(value);
  const room = readHeader(item?.room);
  if (!item || !room) return null;
  const messages = readNewestList(
    item.messages,
    (candidate) => readScopedMessage(candidate, room.id),
    ROOM_VIEW_MESSAGE_LIMIT,
  );
  if (!messages) return null;
  const viewer = readViewer(item.viewer);
  return {
    room,
    messages,
    ...field(
      'leaveDeletesRoom',
      typeof item.leaveDeletesRoom === 'boolean' ? item.leaveDeletesRoom : undefined,
    ),
    members: readList(item.members, readMember, ROOM_VIEW_MEMBER_LIMIT) ?? [],
    latestAgentTurns: readList(item.latestAgentTurns, readAgentTurn, ROOM_VIEW_AGENT_LIMIT) ?? [],
    pendingAgentCommands:
      readList(item.pendingAgentCommands, readPendingAgentCommand, ROOM_VIEW_AGENT_LIMIT) ?? [],
    viewer,
    repositoryResolution: readRepositoryResolution(item.repositoryResolution) ?? 'unverified',
    watchFilters: readWatchFilters(item.watchFilters),
    ...field(
      'toolRows',
      readNewestList(
        item.toolRows,
        (candidate) => readScopedMessage(candidate, room.id),
        ROOM_VIEW_TOOL_ROW_LIMIT,
      ),
    ),
    ...field('directMessage', readDirectMessage(item.directMessage, viewer.identity.pubkey)),
    ...field('parent', readHeader(item.parent)),
    ...field('cornerOpenerAgentId', hex64(item.cornerOpenerAgentId) ? item.cornerOpenerAgentId : undefined),
    ...field('briefing', readList(item.briefing, readRoomViewMessage, ROOM_VIEW_BRIEFING_LIMIT)),
    ...field('cornerPlan', readPlan(item.cornerPlan)),
    ...field('cornerBrief', readCornerBrief(item.cornerBrief)),
    ...field('repository', readRepository(item.repository)),
    ...field('cornerLifecycle', readCornerLifecycle(item.cornerLifecycle)),
    ...field('cornerLocked', typeof item.cornerLocked === 'boolean' ? item.cornerLocked : undefined),
    ...field('cornerOwed', typeof item.cornerOwed === 'boolean' ? item.cornerOwed : undefined),
  };
}


export function isRoomView(value: unknown): value is RoomView {
  return readRoomView(value) !== null;
}


export function readRoomHistoryView(value: unknown): RoomHistoryView | null {
  const item = record(value);
  if (!item || !uuid(item.roomId)) return null;
  const messages = readNewestList(
    item.messages,
    (candidate) => readScopedMessage(candidate, item.roomId as string),
    ROOM_VIEW_MESSAGE_LIMIT,
  );
  // A dropped history row would let a short page claim the beginning while
  // hiding the very message the reader was trying to load.
  if (!messages || !Array.isArray(item.messages) || messages.length !== item.messages.length)
    return null;
  const before = record(item.nextBefore);
  if (item.nextBefore !== undefined && (!before || !integer(before.createdAt) || !hex64(before.id)))
    return null;
  const nextBefore =
    before && integer(before.createdAt) && hex64(before.id)
      ? { createdAt: before.createdAt, id: before.id }
      : undefined;
  return { roomId: item.roomId, messages, ...field('nextBefore', nextBefore) };
}


/** A Room list search page holds at most this many results. */
const MESSAGE_SEARCH_RESULT_LIMIT = 50;


function readMessageSearchSnippetPart(value: unknown): MessageSearchSnippetPart | null {
  const item = record(value);
  if (!item || typeof item.text !== 'string' || typeof item.match !== 'boolean') return null;
  return { text: item.text, match: item.match };
}


function readMessageSearchResult(value: unknown): MessageSearchResult | null {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.messageId) ||
    !uuid(item.roomId) ||
    typeof item.roomName !== 'string' ||
    typeof item.directMessage !== 'boolean' ||
    typeof item.authorName !== 'string' ||
    !integer(item.createdAt) ||
    !Array.isArray(item.snippet)
  )
    return null;
  const snippet = readList(item.snippet, readMessageSearchSnippetPart) ?? [];
  if (snippet.length !== item.snippet.length) return null;
  return {
    messageId: item.messageId,
    roomId: item.roomId,
    roomName: item.roomName,
    directMessage: item.directMessage,
    authorName: item.authorName,
    createdAt: item.createdAt,
    snippet,
  };
}


export function readMessageSearchView(value: unknown): MessageSearchView | null {
  const item = record(value);
  if (!item || !uuid(item.workspaceId) || !Array.isArray(item.results)) return null;
  if (item.nextBefore !== undefined && !nonempty(item.nextBefore)) return null;
  const results = readList(item.results, readMessageSearchResult, MESSAGE_SEARCH_RESULT_LIMIT) ?? [];
  return {
    workspaceId: item.workspaceId,
    results,
    ...field('nextBefore', item.nextBefore as string | undefined),
  };
}


const OUTLINE_DAY = /^\d{4}-\d{2}-\d{2}$/;


function readRoomHistoryOutlineDay(value: unknown): RoomHistoryOutlineDay | null {
  const item = record(value);
  const first = record(item?.first);
  if (
    !item ||
    !first ||
    typeof item.day !== 'string' ||
    !OUTLINE_DAY.test(item.day) ||
    !integer(item.count) ||
    item.count < 1 ||
    !hex64(first.id) ||
    !integer(first.createdAt) ||
    typeof first.authorName !== 'string'
  )
    return null;
  const authorHandle = typeof first.authorHandle === 'string' ? first.authorHandle : undefined;
  return {
    day: item.day,
    count: item.count,
    first: {
      id: first.id,
      createdAt: first.createdAt,
      authorName: first.authorName,
      ...field('authorHandle', authorHandle),
    },
  };
}


export function readRoomHistoryOutline(value: unknown): RoomHistoryOutline | null {
  const item = record(value);
  if (
    !item ||
    !uuid(item.roomId) ||
    !nonempty(item.timeZone) ||
    !integer(item.total) ||
    !Array.isArray(item.days)
  )
    return null;
  // One dropped day would misplace every day marker older than it.
  const days = readList(item.days, readRoomHistoryOutlineDay) ?? [];
  if (days.length !== item.days.length) return null;
  const newest = record(item.newest);
  if (item.newest !== undefined && (!newest || !hex64(newest.id) || !integer(newest.createdAt)))
    return null;
  return {
    roomId: item.roomId,
    timeZone: item.timeZone,
    total: item.total,
    ...field(
      'newest',
      newest ? { id: newest.id as string, createdAt: newest.createdAt as number } : undefined,
    ),
    days,
  };
}


export function readWorkspaceListView(value: unknown): WorkspaceListView | null {
  const item = record(value);
  const viewer = readIdentity(item?.viewer);
  const workspaces = requireList(item?.workspaces, readWorkspace, ROOM_VIEW_WORKSPACE_LIMIT);
  if (!item || !viewer || !workspaces) return null;
  return {
    workspaces,
    viewer,
    truncated: typeof item.truncated === 'boolean' ? item.truncated : false,
    watchFilters: readWatchFilters(item.watchFilters),
    ...field(
      'deletedNotices',
      readList(item.deletedNotices, (candidate) => {
        const notice = record(candidate);
        if (!notice || !uuid(notice.workspaceId) || typeof notice.workspaceName !== 'string') {
          return null;
        }
        return { workspaceId: notice.workspaceId, workspaceName: notice.workspaceName };
      }),
    ),
  };
}


export function isWorkspaceListView(value: unknown): value is WorkspaceListView {
  return readWorkspaceListView(value) !== null;
}


export function readWorkspaceView(value: unknown): WorkspaceView | null {
  const item = record(value);
  const workspace = readWorkspace(item?.workspace);
  const rawWorkspace = record(item?.workspace);
  if (!item || !workspace) return null;
  const managerSettings = record(item.managerSettings);
  const projectedManager =
    managerSettings &&
    (managerSettings.visibility === 'public' || managerSettings.visibility === 'invite-only')
      ? {
          visibility: managerSettings.visibility as 'public' | 'invite-only',
          ...field('allowFixSweep', typeof managerSettings.allowFixSweep === 'boolean' ? managerSettings.allowFixSweep : undefined),
          ...field('rooms', readList(managerSettings.rooms, readManagedRoom, ROOM_VIEW_CHAT_LIMIT)),
          ...field(
            'roomsTruncated',
            typeof managerSettings.roomsTruncated === 'boolean'
              ? managerSettings.roomsTruncated
              : undefined,
          ),
        }
      : undefined;
  return {
    workspace: {
      ...workspace,
      createdAt: integer(rawWorkspace?.createdAt) ? Number(rawWorkspace.createdAt) : 0,
      ...field('about', typeof rawWorkspace?.about === 'string' ? rawWorkspace.about : undefined),
    },
    members: readList(item.members, readMember, WORKSPACE_MEMBER_PAGE_SIZE) ?? [],
    agents: readList(item.agents, readWorkspaceAgent, WORKSPACE_MEMBER_PAGE_SIZE) ?? [],
    membersTruncated: typeof item.membersTruncated === 'boolean' ? item.membersTruncated : false,
    agentsTruncated: typeof item.agentsTruncated === 'boolean' ? item.agentsTruncated : false,
    viewer: readViewer(item.viewer),
    watchFilters: readWatchFilters(item.watchFilters),
    ...field('managerSettings', projectedManager),
    ...field('peopleTotal', integer(item.peopleTotal) ? item.peopleTotal : undefined),
    ...field('agentTotal', integer(item.agentTotal) ? item.agentTotal : undefined),
  };
}


export function isWorkspaceView(value: unknown): value is WorkspaceView {
  return readWorkspaceView(value) !== null;
}


export function readWorkspaceMemberListView(value: unknown): WorkspaceMemberListView | null {
  const item = record(value);
  if (!item) return null;
  const members = requireList(item.members, readMember, WORKSPACE_MEMBER_PAGE_SIZE);
  const agents = requireList(item.agents, readWorkspaceAgent, WORKSPACE_MEMBER_PAGE_SIZE);
  if (!members || !agents) return null;
  return {
    members,
    agents,
    membersTruncated: typeof item.membersTruncated === 'boolean' ? item.membersTruncated : false,
    agentsTruncated: typeof item.agentsTruncated === 'boolean' ? item.agentsTruncated : false,
    ...field('viewer', item.viewer ? readViewer(item.viewer) : undefined),
    ...field('grants', readList(item.grants, readWorkspaceMemberGrantView)),
    ...field('peopleTotal', integer(item.peopleTotal) ? item.peopleTotal : undefined),
    ...field('agentTotal', integer(item.agentTotal) ? item.agentTotal : undefined),
  };
}


export function isWorkspaceMemberListView(value: unknown): value is WorkspaceMemberListView {
  return readWorkspaceMemberListView(value) !== null;
}


export function readChatListView(value: unknown): ChatListView | null {
  const item = record(value);
  const workspace = readWorkspace(item?.workspace);
  const viewer = readIdentity(item?.viewer);
  if (!item || !workspace || !viewer) return null;
  const chats = requireList(item.chats, readChat, ROOM_VIEW_CHAT_LIMIT);
  if (!chats) return null;
  return {
    workspace,
    chats,
    viewer,
    truncated: typeof item.truncated === 'boolean' ? item.truncated : false,
    ...field(
      'unavailable',
      Array.isArray(item.unavailable)
        ? item.unavailable.filter(
            (entry): entry is ChatListUnavailable => entry === 'unread' || entry === 'corners',
          )
        : undefined,
    ),
    watchFilters: readWatchFilters(item.watchFilters),
  };
}


/** @public The phone push-prefetch boundary consumes this guard through the client facade. */
export function isChatListView(value: unknown): value is ChatListView {
  return readChatListView(value) !== null;
}


export function readCornerListView(value: unknown): CornerListView | null {
  const item = record(value);
  const room = readHeader(item?.room);
  if (!item || !room) return null;
  const corners = requireList(item.corners, readCorner);
  if (!corners) return null;
  return {
    room,
    corners,
    ...field(
      'nextArchived',
      typeof item.nextArchived === 'string' && item.nextArchived.length <= 128
        ? item.nextArchived
        : undefined,
    ),
    ...field('nextOpen', typeof item.nextOpen === 'string' && item.nextOpen.length <= 128
      ? item.nextOpen : undefined),
    ...field('summary', readCornerSummary(item.summary)),
    viewer: readViewer(item.viewer),
    watchFilters: readWatchFilters(item.watchFilters),
  };
}


export function isCornerListView(value: unknown): value is CornerListView {
  return readCornerListView(value) !== null;
}
