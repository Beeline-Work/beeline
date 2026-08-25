import {
  selectTranscript,
  type Activity,
  type AttachmentReference,
  type Control,
  type MergeTarget,
  type ReadEvent,
  type WorkspaceSnapshot,
} from '@beeline/buzz-client';
import type { AgentActivityItem, SessionEvent } from './rig-transport';
import type { AgentPresence } from '@beeline/buzz-client';
import type { CornerStatus } from '@/buzz/corners';

export type AgentTurnStatus = 'working' | 'complete' | 'failed';
export type CornerProcessState = 'live' | 'suspended' | 'waiting-for-slot';
export type DeliveryRetryPosture = 'auto' | 'realigning' | 'blocked';

/** A render DTO produced only from the typed read-model. It is never cached. */
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
  isAgentDraft?: boolean;
  relayId?: string;
  activity?: AgentActivityItem[];
  attachments?: AttachmentReference[];
  mentionPubkeys?: string[];
  replyToId?: string;
  isNew?: boolean;
  roomUpdate?: { digest?: string };
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
    status: 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';
    subchannelId?: string;
  };
};

export type ChatEventProjection = {
  message?: ChatDisplayMessage;
  mergeTarget?: MergeTarget;
  previewUrl?: string;
  clearMergeTarget?: boolean;
  archiveChannel?: boolean;
  deliveryFailed?: boolean;
  deliveryFailureReason?: string;
  deliveryRetry?: DeliveryRetryPosture;
  approvalAck?: {
    approvalId: string;
    decision: 'accepted' | 'rejected';
    state?: 'landing' | 'realigning' | 'realigned' | 'content-changed' | 'tip-moved';
    tip?: string;
    rejectedTip?: string;
  };
  deliveryLanded?: boolean;
  landedTip?: string;
  agentPresence?: AgentPresence;
};

export function toRigEvent(event: ReadEvent): SessionEvent {
  const sessionId = event.type === 'unknown' || event.scope === 'workspace' ? '' : event.channelId;
  return { type: 'read-model', sessionId, event };
}

export function sessionEventCursor(event: SessionEvent): number | undefined {
  return event.type === 'read-model' ? event.event.createdAt : undefined;
}

function activityItem(event: Activity): AgentActivityItem {
  const detail = event.detail;
  return {
    kind: detail.kind,
    title: detail.title,
    id: event.stepId,
    ...(detail.operation ? { toolKind: detail.operation } : {}),
    ...(detail.rollup ? { rollup: { ...detail.rollup } } : {}),
    ...(detail.observed ? { observed: detail.observed.map((item) => ({ ...item })) } : {}),
    ...(detail.thoughtMs ? { thoughtMs: detail.thoughtMs } : {}),
    ...(detail.text ? { text: detail.text } : {}),
    ...(detail.status ? { status: detail.status } : {}),
    ...(detail.command ? { command: detail.command } : {}),
    ...(detail.input ? { input: detail.input } : {}),
    ...(detail.output ? { output: detail.output } : {}),
    ...(detail.files ? { files: detail.files.map((file) => ({ ...file })) } : {}),
    ...(detail.plan
      ? {
          plan: {
            ...(detail.plan.objective ? { objective: detail.plan.objective } : {}),
            items: detail.plan.items.map((item) => ({ ...item })),
          },
        }
      : {}),
  };
}

function controlProjection(
  event: Control,
  viewerPubkey: string,
  isNew: boolean,
): ChatEventProjection {
  const common = {
    id: event.eventId,
    text: 'text' in event.payload ? (event.payload.text ?? '') : '',
    isUser: event.authorPubkey === viewerPubkey,
    timestamp: event.createdAt,
    pubkey: event.authorPubkey,
    ...(isNew ? { isNew: true } : {}),
  };
  const payload = event.payload;
  if (payload.kind === 'system') {
    return { message: { ...common, text: payload.text, isSystemNotice: true } };
  }
  if (payload.kind === 'corner-link') {
    return payload.status
      ? {
          message: {
            ...common,
            id: `corner-${payload.cornerId}`,
            text: payload.text ?? '',
            corner: {
              subchannelId: payload.cornerId,
              agentPubkey: event.authorPubkey,
              status: payload.status as CornerStatus,
            },
          },
        }
      : {};
  }
  if (payload.kind === 'target-branch-proposal') {
    return {
      message: {
        ...common,
        id: `target-branch-${event.eventId}`,
        targetBranchProposal: {
          proposalId: payload.proposalId,
          from: payload.from,
          to: payload.to,
          ...(payload.repository ? { repository: payload.repository } : {}),
          ...(payload.agentPubkey ? { agentPubkey: payload.agentPubkey } : {}),
          ...(payload.requesterPubkey ? { requesterPubkey: payload.requesterPubkey } : {}),
        },
      },
    };
  }
  if (payload.kind === 'permission') {
    return {
      message: {
        ...common,
        id: `write-permission-${payload.permissionId}`,
        writePermission: {
          permissionId: payload.permissionId,
          requestId: payload.requestId,
          agentPubkey: payload.agentPubkey,
          tool: payload.tool ?? 'edit files',
          status: payload.status,
          ...(payload.repository ? { repository: payload.repository } : {}),
          ...(payload.subchannelId ? { subchannelId: payload.subchannelId } : {}),
        },
      },
    };
  }
  if (payload.kind !== 'merge') return {};
  const mergeTarget =
    payload.action === 'ready' && payload.repository && payload.branch && payload.tip
      ? {
          repo: payload.repository,
          branch: payload.branch,
          tip: payload.tip,
          ...(payload.patchId ? { patchId: payload.patchId } : {}),
        }
      : undefined;
  return {
    ...(mergeTarget ? { mergeTarget } : {}),
    ...(payload.previewUrl ? { previewUrl: payload.previewUrl } : {}),
    ...(payload.action === 'not-ready' ? { clearMergeTarget: true } : {}),
    ...(payload.action === 'failed'
      ? {
          deliveryFailed: true,
          deliveryFailureReason: payload.text ?? 'The daemon could not land this change.',
          ...(payload.retry ? { deliveryRetry: payload.retry } : {}),
        }
      : {}),
    ...(payload.action === 'approval-ack' && payload.decision
      ? {
          approvalAck: {
            approvalId: payload.approvalId ?? event.eventId,
            decision: payload.decision,
            ...(payload.state ? { state: payload.state } : {}),
            ...(payload.tip ? { tip: payload.tip } : {}),
            ...(payload.rejectedTip ? { rejectedTip: payload.rejectedTip } : {}),
          },
        }
      : {}),
    ...(payload.action === 'landed'
      ? { deliveryLanded: true, ...(payload.tip ? { landedTip: payload.tip } : {}) }
      : {}),
    ...(event.visibility !== 'hidden'
      ? { message: { ...common, isSystemNotice: event.visibility === 'system-line' } }
      : {}),
  };
}

/** Typed-event effects for ephemeral UI state. Raw relay data is not accepted. */
export function projectReadEvent(
  event: ReadEvent,
  viewerPubkey: string,
  isNew = false,
): ChatEventProjection {
  if (event.type === 'unknown' || event.scope === 'workspace') return {};
  if (event.type === 'human-message' || event.type === 'agent-message') {
    return {
      message: {
        id: event.eventId,
        text: event.body,
        isUser: event.authorPubkey === viewerPubkey,
        timestamp: event.createdAt,
        pubkey: event.authorPubkey,
        ...(event.type === 'agent-message' ? { isAgentAuthor: true } : {}),
        ...(event.attachments.length ? { attachments: [...event.attachments] } : {}),
        ...(event.mentionPubkeys.length ? { mentionPubkeys: [...event.mentionPubkeys] } : {}),
        ...(event.reply ? { replyToId: event.reply.eventId } : {}),
        ...(isNew ? { isNew: true } : {}),
      },
    };
  }
  if (event.type === 'activity') {
    return {
      message: {
        id: event.eventId,
        text: event.detail.text ?? '',
        isUser: false,
        timestamp: event.createdAt,
        pubkey: event.authorPubkey,
        isAgentActivity: true,
        activity: [activityItem(event)],
        ...(isNew ? { isNew: true } : {}),
      },
    };
  }
  if (event.type === 'session-update') {
    if (event.update.kind === 'presence') {
      return {
        agentPresence: {
          agentPubkey: event.update.agentPubkey,
          status: event.update.status,
          observedAt: event.createdAt * 1_000,
        },
      };
    }
    return {};
  }
  if (event.type === 'lifecycle') {
    return event.lifecycle.entity === 'room' &&
      (event.lifecycle.state === 'archived' || event.lifecycle.state === 'deleted')
      ? { archiveChannel: true }
      : {};
  }
  if (event.type === 'control') return controlProjection(event, viewerPubkey, isNew);
  return {};
}

/** The transcript surface: one pure snapshot selector, then a typed render map. */
export function transcriptMessages(
  snapshot: WorkspaceSnapshot,
  channelId: string,
  viewerPubkey: string,
  input?: {
    readonly before?: number;
    readonly limit?: number;
    readonly newIds?: ReadonlySet<string>;
  },
): ChatDisplayMessage[] {
  return selectTranscript(snapshot, channelId, input).flatMap<ChatDisplayMessage>((item) => {
    if (item.kind === 'human-message' || item.kind === 'agent-message') {
      const event = snapshot.rooms[channelId]?.eventJournal[item.id];
      return event
        ? (projectReadEvent(event, viewerPubkey, input?.newIds?.has(item.id)).message ?? [])
        : [];
    }
    if (item.kind === 'activity') {
      return [
        {
          id: item.id,
          text: '',
          isUser: false,
          timestamp: item.timestamp,
          isAgentActivity: true,
          activity: item.steps.map(activityItem),
          ...(input?.newIds?.has(item.id) ? { isNew: true } : {}),
        },
      ];
    }
    const event = snapshot.rooms[channelId]?.eventJournal[item.id];
    return event?.type === 'control'
      ? (projectReadEvent(event, viewerPubkey, input?.newIds?.has(item.id)).message ?? [])
      : [];
  });
}

/** Ephemeral page/optimistic merge. The normalized snapshot remains the cache authority. */
export function mergeDisplayPages(
  ...pages: readonly (readonly ChatDisplayMessage[])[]
): ChatDisplayMessage[] {
  const byId = new Map<string, ChatDisplayMessage>();
  for (const page of pages) {
    for (const message of page) byId.set(message.id, message);
  }
  return [...byId.values()].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
}

/** Latest typed effects, replayed deterministically from a snapshot. */
export function selectChannelEffects(
  snapshot: WorkspaceSnapshot,
  channelId: string,
  viewerPubkey: string,
): ChatEventProjection[] {
  const room = snapshot.rooms[channelId];
  if (!room) return [];
  return Object.values(room.eventJournal)
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId),
    )
    .map((event) => projectReadEvent(event, viewerPubkey));
}
