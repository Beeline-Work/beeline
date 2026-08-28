import type {
  Agent,
  AttachmentReference,
  ChatListItem,
  ChatListWorkspace,
  CommunityMember,
  RoomView,
  RoomViewMember,
  RoomViewMessage,
  WorkspaceView,
} from '@beeline/buzz-client';
import type { AgentActivityItem } from '@/sync/transport';
import type { CornerStatus, CornerSummary } from '@/buzz/corners';

export type AgentTurnStatus = 'working' | 'complete' | 'failed';
export type CornerProcessState = 'live' | 'suspended' | 'waiting-for-slot';
export type DeliveryRetryPosture = 'auto' | 'realigning' | 'blocked';
export type AgentPresentation = Pick<Agent, 'pubkey' | 'displayName' | 'avatar' | 'soulProfile'>;

export type WorkspaceMemberDisplayItem = {
  peerPubkey: string;
  peerName: string;
  peerKind: 'person' | 'agent';
  avatarUrl?: string;
  role?: 'owner' | 'admin' | 'member';
};

/** Presentation-only row. It is recomputed from server DTO partitions and is never persisted. */
export type ChatDisplayMessage = {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  pubkey?: string;
  isMergeSummary?: boolean;
  isArchivedNotice?: boolean;
  isSystemNotice?: boolean;
  isAgentAuthor?: boolean;
  isAgentActivity?: boolean;
  isAgentLiveTurn?: boolean;
  isAgentDraft?: boolean;
  relayId?: string;
  activity?: AgentActivityItem[];
  agentThought?: string;
  agentMessageDraft?: string;
  mergeNotReadyTransition?: string;
  durableFact?: { kind: 'failure' | 'merge' | 'action' };
  attachments?: AttachmentReference[];
  mentionPubkeys?: string[];
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
  writePermission?: {
    permissionId: string;
    requestId: string;
    agentPubkey: string;
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
    ...(activity.operation ? { toolKind: activity.operation } : {}),
    ...(activity.rollup ? { rollup: { ...activity.rollup } } : {}),
    ...(activity.observed ? { observed: activity.observed.map((item) => ({ ...item })) } : {}),
    ...(activity.thoughtMs ? { thoughtMs: activity.thoughtMs } : {}),
    ...(activity.status ? { status: activity.status } : {}),
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
  return {
    id: message.id,
    relayId: message.id,
    text: message.text,
    isUser: message.author.pubkey === viewerPubkey,
    timestamp: message.createdAt,
    pubkey: message.author.pubkey,
    reference: message.reference,
    ...(message.author.kind === 'agent' ? { isAgentAuthor: true } : {}),
    ...(message.presentation === 'system' ? { isSystemNotice: true } : {}),
    ...(message.presentation === 'activity' ? { isAgentActivity: true } : {}),
    ...(message.activity ? { activity: activityItems(message) } : {}),
    ...(message.attachments ? { attachments: [...message.attachments] } : {}),
    ...(message.mentionPubkeys ? { mentionPubkeys: [...message.mentionPubkeys] } : {}),
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
    ...(message.permission
      ? {
          writePermission: {
            permissionId: message.permission.permissionId,
            requestId: message.permission.requestId,
            agentPubkey: message.permission.agent.pubkey,
            tool: message.permission.tool,
            status: message.permission.status,
            ...(message.permission.repository ? { repository: message.permission.repository } : {}),
            ...(message.permission.purpose ? { purpose: message.permission.purpose } : {}),
            ...(message.permission.cornerId ? { subchannelId: message.permission.cornerId } : {}),
          },
        }
      : {}),
    ...(message.merge?.action === 'not-ready' && message.text.trim()
      ? { mergeNotReadyTransition: message.text.trim() }
      : {}),
  };
}

export function displayRoomMessages(
  messages: readonly RoomViewMessage[],
  viewerPubkey: string,
): ChatDisplayMessage[] {
  return messages.map((message) => displayRoomMessage(message, viewerPubkey));
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
  return view.corners.map(
    (item) =>
      ({
        id: item.corner.id,
        name: item.corner.name,
        status: item.status,
        machineState: item.status === 'closed' ? 'closed' : item.status,
        stateAt: item.corner.updatedAt,
        openerPubkey: item.agent?.pubkey ?? '',
        ...(item.agent ? { agentPubkey: item.agent.pubkey } : {}),
      }) as CornerSummary,
  );
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
    ...(member.identity.avatar ? { avatar: member.identity.avatar } : {}),
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
