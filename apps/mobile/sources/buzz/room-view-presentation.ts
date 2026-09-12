import type {
  Agent,
  AttachmentReference,
  ChatListItem,
  ChatListWorkspace,
  CommunityMember,
  RoomView,
  RoomViewAgentTurn,
  RoomViewIdentity,
  RoomViewMember,
  RoomViewMessage,
  WorkspaceView,
} from '@beeline/buzz-client';
import {
  ROOM_VIEW_AGENT_LIMIT,
  ROOM_VIEW_MESSAGE_LIMIT,
  type SystemEvent,
  type SystemSubject,
} from '@beeline/api-contract/phone';
import type { AgentActivityItem } from '@/sync/transport';
import type { DisplayableAgent } from '@/buzz/agent-display';
import type { CornerStatus, CornerSummary } from '@/buzz/corners';
import { cornerName } from '@/buzz/corners';
import { remoteTerminalState } from '@/buzz/corner-display-state';
import type { NotificationLifecycleRun } from '@/buzz/system-lines';

export type AgentTurnStatus = 'working' | 'complete' | 'failed';
export type CornerProcessState = 'live' | 'suspended' | 'waiting-for-slot';
/** What a screen hands `resolveAgentDisplayIdentity` — the relay-side agent
 *  record plus the server-assigned face the Room view carries. One shape, so
 *  a screen cannot assemble an agent this resolution cannot read. */
export type AgentPresentation = DisplayableAgent;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Give a fresh authenticated Room response structural sharing with the last
 * response. Unchanged JSON subtrees keep their object identity, while every
 * changed field still comes from the new server-owned response.
 */
function shareResponseValue(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    let unchanged = previous.length === next.length;
    const shared = next.map((value, index) => {
      const item = shareResponseValue(previous[index], value);
      if (item !== previous[index]) unchanged = false;
      return item;
    });
    return unchanged ? previous : shared;
  }
  if (isRecord(previous) && isRecord(next)) {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    let unchanged = previousKeys.length === nextKeys.length;
    const shared: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const value = shareResponseValue(previous[key], next[key]);
      shared[key] = value;
      if (value !== previous[key]) unchanged = false;
    }
    return unchanged ? previous : shared;
  }
  return next;
}

function shareResponseArrayByKey<T>(
  previous: readonly T[],
  next: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  const previousByKey = new Map(previous.map((value) => [key(value), value]));
  const shared = next.map((value) => shareResponseValue(previousByKey.get(key(value)), value) as T);
  return previous.length === shared.length &&
    shared.every((value, index) => value === previous[index])
    ? previous
    : shared;
}

export function reconcileRoomView(previous: RoomView | null, next: RoomView): RoomView {
  if (!previous) return next;
  const messages = shareResponseArrayByKey(
    previous.messages,
    next.messages,
    (message) => message.id,
  );
  const members = shareResponseArrayByKey(
    previous.members,
    next.members,
    (member) => member.identity.pubkey,
  );
  const corners = shareResponseArrayByKey(
    previous.corners,
    next.corners,
    (corner) => corner.corner.id,
  );
  const briefing = next.briefing
    ? shareResponseArrayByKey(previous.briefing ?? [], next.briefing, (message) => message.id)
    : undefined;
  return shareResponseValue(previous, {
    ...next,
    messages,
    members,
    corners,
    ...(briefing ? { briefing } : {}),
  }) as RoomView;
}

/** Merge one server-projected committed message into the bounded Room window. */
export function reconcileRoomMessageDelta(view: RoomView, message: RoomViewMessage): RoomView {
  const messages = [...view.messages.filter((candidate) => candidate.id !== message.id), message]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .slice(-ROOM_VIEW_MESSAGE_LIMIT);
  return reconcileRoomView(view, { ...view, messages });
}

/** Merge the server's latest persisted turn for one agent. Terminal state also
 * removes that agent's transient activity, exactly as the next full read does. */
export function reconcileRoomTurnDelta(view: RoomView, turn: RoomViewAgentTurn): RoomView {
  const previous = view.latestAgentTurns.find(
    (candidate) => candidate.agentPubkey === turn.agentPubkey,
  );
  const sameGeneration =
    previous?.requestId === turn.requestId && previous.generationId === turn.generationId;
  if (
    previous &&
    (previous.createdAt > turn.createdAt ||
      (sameGeneration &&
        previous.createdAt === turn.createdAt &&
        previous.status !== 'working' &&
        turn.status === 'working'))
  )
    return view;
  const latestAgentTurns = [
    ...view.latestAgentTurns.filter((candidate) => candidate.agentPubkey !== turn.agentPubkey),
    turn,
  ]
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || left.agentPubkey.localeCompare(right.agentPubkey),
    )
    .slice(0, ROOM_VIEW_AGENT_LIMIT);
  const messages = view.messages.filter(
    (message) =>
      message.presentation !== 'activity' ||
      message.durableFact ||
      message.author.pubkey !== turn.agentPubkey ||
      (turn.status === 'working' && message.createdAt >= turn.createdAt),
  );
  return reconcileRoomView(view, { ...view, messages, latestAgentTurns });
}

export type RoomMessageProjector = {
  project(messages: readonly RoomViewMessage[], viewerPubkey: string): ChatDisplayMessage[];
  reset(): void;
};

/** One bounded projection cache per mounted Room surface. */
export function createRoomMessageProjector(): RoomMessageProjector {
  type Entry = {
    source: RoomViewMessage;
    viewerPubkey: string;
    projected: ChatDisplayMessage;
  };
  let cache = new Map<string, Entry>();
  return {
    project(messages, viewerPubkey) {
      const nextCache = new Map<string, Entry>();
      const projected = messages.map((message) => {
        const current = cache.get(message.id);
        const value =
          current?.source === message && current.viewerPubkey === viewerPubkey
            ? current.projected
            : displayRoomMessage(message, viewerPubkey);
        nextCache.set(message.id, { source: message, viewerPubkey, projected: value });
        return value;
      });
      cache = nextCache;
      return projected;
    },
    reset() {
      cache.clear();
    },
  };
}

export type WorkspaceMemberDisplayItem = {
  peerPubkey: string;
  peerName: string;
  peerKind: 'person' | 'agent';
  avatarUrl?: string;
  /** The chosen face id; absent → derived from the pubkey. */
  face?: string;
  role?: 'owner' | 'admin' | 'member';
};

/** Presentation-only row. It is recomputed from server DTO partitions and is never persisted. */
export type ChatDisplayMessage = {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  /** Current server-resolved identity for this row; never replace it with a local label cache. */
  authorIdentity?: RoomViewIdentity;
  pubkey?: string;
  isArchivedNotice?: boolean;
  isSystemNotice?: boolean;
  /** The server-phrased event behind a system line or card header (`buzz/system-lines.ts`). */
  systemEvent?: SystemEvent;
  /** Every subject of a folded run of system lines, oldest first. */
  systemSubjects?: SystemSubject[];
  /** The ids of every row folded into this one. */
  foldedIds?: string[];
  /** A render-time-only run of adjacent repository notification cards. */
  notificationLifecycleRun?: NotificationLifecycleRun;
  isAgentAuthor?: boolean;
  isAgentActivity?: boolean;
  isAgentLiveTurn?: boolean;
  isAgentDraft?: boolean;
  /** The turn this row answers. The join a settling reply uses to recover the
   *  provisional text it is replacing (`buzz/draft-settle.ts`, C98). */
  requestId?: string;
  relayId?: string;
  activity?: AgentActivityItem[];
  agentThought?: string;
  agentMessageDraft?: string;
  durableFact?: { kind: 'failure' | 'merge' | 'action' };
  attachments?: AttachmentReference[];
  mentionPubkeys?: string[];
  reactions?: RoomViewMessage['reactions'];
  replyToId?: string;
  isNew?: boolean;
  roomUpdate?: { digest?: string };
  reference?: RoomViewMessage['reference'];
  corner?: { subchannelId: string; agentPubkey?: string; status: CornerStatus };
  agentTurn?: {
    requestId: string;
    agentPubkey: string;
    status: AgentTurnStatus;
    generationId?: string;
  };
  cornerProcess?: {
    sessionId: string;
    agentPubkey: string;
    state: CornerProcessState;
    sequence: number;
  };
  targetBranchProposal?: {
    proposalId: string;
    from: string;
    to: string;
    repository?: string;
    agentPubkey?: string;
    requesterPubkey?: string;
  };
  /** Repository activity is a typed surface, never a transcript speaker. */
  githubEvent?: NonNullable<RoomViewMessage['githubEvent']>;
  /** Daemon lifecycle facts are server-projected cards, never prose rows. */
  relay?: RoomViewMessage['relay'];
  relayReports?: ChatDisplayMessage[];
  daemonFact?: NonNullable<RoomViewMessage['daemonFact']>;
  /** An agent asking its owner for reach; rendered as the grant card. */
  grantRequest?: NonNullable<RoomViewMessage['grantRequest']>;
  writePermission?: {
    permissionId: string;
    requestId: string;
    agentPubkey: string;
    requesterPubkey: string;
    deciderPubkey?: string;
    tool: string;
    repository?: string;
    purpose?: 'squire-spending';
    status: 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';
    subchannelId?: string;
  };
};

function activityItems(message: RoomViewMessage): AgentActivityItem[] | undefined {
  return message.activity?.map((activity, index) => ({
    kind: activity.kind,
    title: activity.title,
    id: `${message.id}:${index}`,
    ...(activity.text ? { text: activity.text } : {}),
    ...(activity.operation ? { toolKind: activity.operation } : {}),
    ...(activity.rollup ? { rollup: { ...activity.rollup } } : {}),
    ...(activity.observed ? { observed: activity.observed.map((item) => ({ ...item })) } : {}),
    ...(activity.thoughtMs ? { thoughtMs: activity.thoughtMs } : {}),
    ...(activity.status ? { status: activity.status } : {}),
    ...(activity.command ? { command: activity.command } : {}),
    ...(activity.input ? { input: activity.input } : {}),
    ...(activity.output ? { output: activity.output } : {}),
    ...(activity.requestedBy ? { requestedBy: { ...activity.requestedBy } } : {}),
    ...(activity.files ? { files: activity.files.map((file) => ({ ...file })) } : {}),
    ...(activity.plan
      ? { plan: { ...activity.plan, items: activity.plan.items.map((item) => ({ ...item })) } }
      : {}),
  }));
}

export function displayRoomMessage(
  message: RoomViewMessage,
  viewerPubkey: string,
): ChatDisplayMessage {
  const githubEvent = message.githubEvent ? { ...message.githubEvent } : undefined;
  const daemonFact = message.daemonFact
    ? {
        ...message.daemonFact,
        ...(message.daemonFact.pullRequest
          ? { pullRequest: { ...message.daemonFact.pullRequest } }
          : {}),
        ...(message.daemonFact.subgoals
          ? { subgoals: message.daemonFact.subgoals.map((subgoal) => ({ ...subgoal })) }
          : {}),
      }
    : undefined;
  return {
    id: message.id,
    relayId: message.id,
    text: message.text,
    timestamp: message.createdAt,
    ...(githubEvent || daemonFact
      ? {
          isUser: false,
          ...(daemonFact ? { authorIdentity: message.author, pubkey: message.author.pubkey } : {}),
        }
      : {
          isUser: message.author.pubkey === viewerPubkey,
          authorIdentity: message.author,
          pubkey: message.author.pubkey,
        }),
    reference: message.reference,
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(!githubEvent && !daemonFact && message.author.kind === 'agent'
      ? { isAgentAuthor: true }
      : {}),
    ...(message.presentation === 'system' ? { isSystemNotice: true } : {}),
    ...(message.systemEvent ? { systemEvent: message.systemEvent } : {}),
    ...(message.presentation === 'activity' ? { isAgentActivity: true } : {}),
    ...(message.activity ? { activity: activityItems(message) } : {}),
    ...(message.attachments ? { attachments: [...message.attachments] } : {}),
    ...(message.mentionPubkeys ? { mentionPubkeys: [...message.mentionPubkeys] } : {}),
    ...(message.reactions
      ? { reactions: message.reactions.map((reaction) => ({ ...reaction })) }
      : {}),
    ...(message.reply ? { replyToId: message.reply.eventId } : {}),
    ...(message.durableFact ? { durableFact: { kind: message.durableFact } } : {}),
    ...(message.corner
      ? {
          corner: {
            subchannelId: message.corner.id,
            status: message.corner.status as CornerStatus,
          },
        }
      : {}),
    ...(message.targetBranch
      ? {
          targetBranchProposal: {
            proposalId: message.targetBranch.proposalId,
            from: message.targetBranch.from,
            to: message.targetBranch.to,
            ...(message.targetBranch.repository
              ? { repository: message.targetBranch.repository }
              : {}),
            ...(message.targetBranch.agent
              ? { agentPubkey: message.targetBranch.agent.pubkey }
              : {}),
            ...(message.targetBranch.requester
              ? { requesterPubkey: message.targetBranch.requester.pubkey }
              : {}),
          },
        }
      : {}),
    ...(githubEvent ? { githubEvent } : {}),
    ...(daemonFact ? { daemonFact } : {}),
    ...(message.relay ? { relay: message.relay } : {}),
    ...(message.grantRequest
      ? {
          grantRequest: {
            ...message.grantRequest,
            grants: message.grantRequest.grants.map((grant) => ({ ...grant })),
          },
        }
      : {}),
    ...(message.permission
      ? {
          writePermission: {
            permissionId: message.permission.permissionId,
            requestId: message.permission.requestId,
            agentPubkey: message.permission.agent.pubkey,
            requesterPubkey: message.permission.requester.pubkey,
            ...(message.permission.decider
              ? { deciderPubkey: message.permission.decider.pubkey }
              : {}),
            tool: message.permission.tool,
            status: message.permission.status,
            ...(message.permission.repository ? { repository: message.permission.repository } : {}),
            ...(message.permission.purpose ? { purpose: message.permission.purpose } : {}),
            ...(message.permission.cornerId ? { subchannelId: message.permission.cornerId } : {}),
          },
        }
      : {}),
  };
}

/**
 * One identity source for Room and corner composers/transcripts.
 * Message authorship refreshes membership presentation from the current
 * server view; the newest loaded row wins over any label painted from disk.
 */
export function conversationIdentityByPubkey(
  members: readonly RoomViewMember[],
  messages: readonly ChatDisplayMessage[],
): Map<string, RoomViewIdentity> {
  const identities = new Map(members.map((member) => [member.identity.pubkey, member.identity]));
  for (const message of messages) {
    if (message.authorIdentity) {
      identities.set(message.authorIdentity.pubkey, message.authorIdentity);
    }
  }
  return identities;
}

export function displayRoomMessages(
  messages: readonly RoomViewMessage[],
  viewerPubkey: string,
): ChatDisplayMessage[] {
  return messages.map((message) => displayRoomMessage(message, viewerPubkey));
}

/**
 * Tool rows are an additive corner payload so the wire `messages` field stays
 * compatible with phones that enforce its 30-entry contract.
 */
export function roomViewTranscriptMessages(
  view: Pick<RoomView, 'messages' | 'toolRows'>,
): RoomViewMessage[] {
  const byId = new Map<string, RoomViewMessage>();
  for (const message of [...view.messages, ...(view.toolRows ?? [])]) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

/**
 * The helper posts each settled tool call as its own durable activity row so
 * the record survives a helper restart. The phone reads them back as ONE
 * collapsed group per turn: a run of adjacent settled activity rows from the
 * same agent folds into the first row (its id and stamp stay stable) with every
 * member's activity concatenated in order. A human steer, agent prose, or a
 * durable-fact card between two rows ends the run. The agent's own in-flight
 * draft lane is never swallowed and never breaks the run: it is re-emitted
 * directly below the group it interrupted.
 */
export function foldSettledActivityRuns(
  messages: readonly ChatDisplayMessage[],
): ChatDisplayMessage[] {
  const folded: ChatDisplayMessage[] = [];
  let run: { pubkey: string; activity: AgentActivityItem[]; drafts: ChatDisplayMessage[] } | null =
    null;
  const close = () => {
    if (!run) return;
    folded.push(...run.drafts);
    run = null;
  };
  for (const message of messages) {
    if (run && message.isAgentDraft && message.pubkey === run.pubkey) {
      run.drafts.push(message);
      continue;
    }
    // Durable narration is a transcript boundary, not another tool to fold.
    // A producer may put the narration and the tool it precedes in one row;
    // keeping that row intact preserves their order on a reopened corner.
    if (message.activity?.some((item) => item.kind === 'output')) {
      close();
      folded.push(message);
      continue;
    }
    const settledActivity =
      message.isAgentActivity &&
      !message.isAgentLiveTurn &&
      !message.isAgentDraft &&
      !message.durableFact &&
      message.pubkey &&
      message.activity?.length;
    if (!settledActivity) {
      close();
      folded.push(message);
      continue;
    }
    if (run && run.pubkey === message.pubkey) {
      run.activity.push(...message.activity!);
      continue;
    }
    close();
    const activity = [...message.activity!];
    run = { pubkey: message.pubkey!, activity, drafts: [] };
    folded.push({ ...message, activity });
  }
  close();
  return folded;
}

export function mergeDisplayPages(
  ...pages: readonly (readonly ChatDisplayMessage[])[]
): ChatDisplayMessage[] {
  const byId = new Map<string, ChatDisplayMessage>();
  for (const page of pages) for (const message of page) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
}

export function cornerSummaries(view: Pick<RoomView, 'corners'>): CornerSummary[] {
  return view.corners.map((item) => {
    // "Finished" is decided in exactly one place product-wide
    // (`corner-display-state.ts`), so this adapter and the corner rows that
    // read its output can never disagree about whether a corner is over.
    const ended = remoteTerminalState(item.lifecycle);
    const machineState =
      ended ??
      (item.status === 'working'
        ? 'working'
        : item.status === 'waiting'
          ? 'waiting'
          : item.status === 'open'
            ? 'open'
            : item.status === 'concluded'
              ? 'concluded'
              : item.status === 'closed'
                ? 'closed'
                : 'idle');
    // `status` stays the COMPATIBILITY projection it has always been: a
    // working corner reads `live` without the freshness lease, because every
    // consumer re-derives through `currentCornerStatus` at paint time.
    const status =
      machineState === 'working'
        ? 'live'
        : ended
          ? ended === 'concluded'
            ? 'merged'
            : 'archived'
          : machineState === 'waiting'
            ? item.reason === 'failure'
              ? 'failed'
              : item.reason === 'question'
                ? 'needs-attention'
                : 'open'
            : null;
    return {
      id: item.corner.id,
      // Every consumer of a corner summary — the Room row's fact line, the
      // corner deck, the header — reads the SHORT title (C89).
      name: cornerName(item.corner.name, item.corner.id),
      status,
      machineState,
      ...(machineState === 'waiting' && item.reason ? { machineReason: item.reason } : {}),
      stateAt: item.statusAt ?? item.corner.updatedAt,
      openerPubkey: item.agent?.pubkey ?? '',
      ...(item.agent ? { agentPubkey: item.agent.pubkey } : {}),
    } as CornerSummary;
  });
}

export function workspaceRailItem(workspace: ChatListWorkspace) {
  return {
    communityId: workspace.id,
    name: workspace.name,
    ...(workspace.avatar ? { avatar: workspace.avatar } : {}),
  };
}

export function memberAgent(member: RoomViewMember, _workspaceId: string): AgentPresentation {
  return {
    displayName: member.identity.name,
    pubkey: member.identity.pubkey,
    ...(member.identity.handle ? { handle: member.identity.handle } : {}),
    ...(member.identity.avatar ? { avatar: member.identity.avatar } : {}),
    // The server's own assignment travels with the name: an agent's animal
    // decides its name and its soul too, so a tile that redraws it from the
    // seed contradicts both (`agent-display.ts`).
    ...(member.identity.face ? { face: member.identity.face } : {}),
  };
}

export function workspacePeople(view: WorkspaceView): CommunityMember[] {
  return view.members
    .filter((member) => member.identity.kind === 'human')
    .map((member) => ({ pubkey: member.identity.pubkey, role: member.role }));
}

export function chatListItemUpdatedAt(item: ChatListItem): number {
  return item.latestMessage?.createdAt ?? item.room.updatedAt;
}
