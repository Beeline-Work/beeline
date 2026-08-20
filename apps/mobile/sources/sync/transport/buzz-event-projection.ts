import type { AgentActivityItem, SessionEvent } from './rig-transport';
import {
  parseAttachmentTags,
  type AttachmentReference,
  type AgentPresence,
  type MergeTarget,
  type SessionEvent as BuzzSessionEvent,
} from '@beeline/buzz-client';
import { agentDraftFromSessionEvent } from '@/buzz/agent-draft';
import { agentPresenceFromSessionEvent } from '@/buzz/agent-presence';
import { cornerStatusPrecedence, mapRawCornerStatusTag, type CornerStatus } from '@/buzz/corners';
import { decodePercentEncoding } from '@/buzz/ledger-text';
import { isRetiredAgentStateNotice } from '@/buzz/retired-agent-notices';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

/** Read ACP text/content blocks without ever exposing the JSON wire envelope. */
function readTextContent(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => readTextContent(part, depth + 1))
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.text === 'string' && record.text) return record.text;
  if ('content' in record) return readTextContent(record.content, depth + 1);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function compactFiles(value: unknown): NonNullable<AgentActivityItem['files']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value.flatMap((item) => {
    const record = asRecord(item);
    const path = stringValue(record?.path);
    return path
      ? [
          {
            path,
            ...(stringValue(record?.status) ? { status: stringValue(record?.status) } : {}),
            ...(stringValue(record?.diff) ? { diff: stringValue(record?.diff) } : {}),
          },
        ]
      : [];
  });
  return files.length ? files : undefined;
}

function compactPlan(value: unknown): AgentActivityItem['plan'] | undefined {
  const plan = asRecord(value);
  if (!plan || !Array.isArray(plan.items)) return undefined;
  const items = plan.items.flatMap((item) => {
    const record = asRecord(item);
    const step = stringValue(record?.step);
    const status = record?.status;
    if (!step || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) {
      return [];
    }
    return [{ step, status }] satisfies NonNullable<AgentActivityItem['plan']>['items'];
  });
  const objective = stringValue(plan.objective);
  return items.length || objective ? { ...(objective ? { objective } : {}), items } : undefined;
}

/** Verb -> count tally of the tool calls body counted but did not project. */
function compactRollup(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const rollup: Record<string, number> = {};
  for (const [verb, count] of Object.entries(record)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) rollup[verb] = count;
  }
  return Object.keys(rollup).length ? rollup : undefined;
}

/** Per-call receipts (target + short result) for the folded calls the tally above counts. */
function compactObserved(value: unknown): NonNullable<AgentActivityItem['observed']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const observed = value.flatMap((item) => {
    const record = asRecord(item);
    const verb = stringValue(record?.verb);
    if (!verb) return [];
    return [
      {
        verb,
        ...(stringValue(record?.target) ? { target: stringValue(record?.target) } : {}),
        ...(stringValue(record?.result) ? { result: stringValue(record?.result) } : {}),
      },
    ];
  });
  return observed.length ? observed : undefined;
}

/**
 * Body activity is a JSON-encoded ACP `session/update` envelope. Project the
 * user-facing content, not that transport envelope. Plain-text activity from
 * older bodies remains valid.
 */
export function agentActivityDetails(content: string): AgentActivityItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return content.trim() ? [{ kind: 'output', title: 'Output', text: content }] : [];
  }

  if (typeof parsed === 'string') {
    return parsed.trim() ? [{ kind: 'output', title: 'Output', text: parsed }] : [];
  }
  const envelope = asRecord(parsed);
  if (!envelope) return [];
  const update = asRecord(envelope.update);
  if (!update) {
    const text = readTextContent(envelope.content);
    return text ? [{ kind: 'output', title: 'Output', text }] : [];
  }

  if (update.sessionUpdate === 'activity_batch' && Array.isArray(update.updates)) {
    return update.updates.flatMap((item) => agentActivityDetails(JSON.stringify({ update: item })));
  }

  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  if (sessionUpdate === 'tool_activity') {
    const title = stringValue(update.title) ?? 'Tool';
    const command = stringValue(update.command);
    const input = stringValue(update.input);
    const output = stringValue(update.output);
    const files = compactFiles(update.files);
    const plan = compactPlan(update.plan);
    return [
      {
        kind: 'tool',
        title,
        ...(stringValue(update.toolCallId) ? { id: stringValue(update.toolCallId) } : {}),
        ...(stringValue(update.kind) ? { toolKind: stringValue(update.kind) } : {}),
        ...(stringValue(update.status) ? { status: stringValue(update.status) } : {}),
        ...(command ? { command } : {}),
        ...(input ? { input } : {}),
        ...(output ? { output, text: output } : {}),
        ...(files ? { files } : {}),
        ...(plan ? { plan } : {}),
      },
    ];
  }
  if (sessionUpdate === 'progress_update') {
    const text = stringValue(update.text);
    return text ? [{ kind: 'output', title: 'Update', text }] : [];
  }
  if (sessionUpdate === 'activity_summary') {
    // Body's synthetic per-batch receipt. Its text is mechanism, not narration,
    // and it carries the only count of the observational tool calls that never
    // reach the wire on their own — so it gets its own kind rather than being
    // mistaken for the agent's prose.
    const rollup = compactRollup(update.rollup);
    const observed = compactObserved(update.observed);
    const text = readTextContent(update.content) ?? stringValue(update.text);
    const thoughtMs =
      typeof update.thoughtMs === 'number' && Number.isFinite(update.thoughtMs) && update.thoughtMs > 0
        ? update.thoughtMs
        : undefined;
    // The agent's plan rides this receipt rather than an event of its own —
    // body publishes it here whenever it changes, so the corner's objective
    // panel costs no extra relay write. See `projectActivity` in
    // `apps/body/src/activity.ts`.
    const plan = compactPlan(update.plan);
    if (!rollup && !observed && !text && !thoughtMs && !plan) return [];
    return [
      {
        kind: 'summary',
        title: 'Summary',
        ...(text ? { text } : {}),
        ...(rollup ? { rollup } : {}),
        ...(observed ? { observed } : {}),
        ...(thoughtMs ? { thoughtMs } : {}),
        ...(plan ? { plan } : {}),
      },
    ];
  }
  const text =
    readTextContent(update.content) ??
    readTextContent(update.message) ??
    readTextContent(update.output);
  const toolCall = asRecord(update.toolCall);
  const title =
    typeof update.title === 'string'
      ? update.title
      : typeof toolCall?.title === 'string'
        ? toolCall.title
        : undefined;
  const status =
    typeof update.status === 'string'
      ? update.status
      : typeof toolCall?.status === 'string'
        ? toolCall.status
        : undefined;

  if (
    sessionUpdate.includes('thought') ||
    sessionUpdate.includes('thinking') ||
    sessionUpdate === 'agent_message_chunk'
  ) {
    return text ? [{ kind: 'thinking', title: 'Thinking', text }] : [];
  }
  if (
    sessionUpdate === 'tool_call' ||
    sessionUpdate === 'tool_call_update' ||
    sessionUpdate === 'tool_result'
  ) {
    return [
      {
        kind: 'tool',
        title: title ?? (sessionUpdate === 'tool_result' ? 'Result' : 'Tool'),
        ...(text ? { text } : {}),
        ...(status ? { status } : {}),
      },
    ];
  }
  // Only explicit tool updates are tool output. Other ACP prose is agent
  // narration and belongs directly in the readable activity feed.
  if (text) return [{ kind: 'thinking', title: 'Thinking', text }];

  // Metadata-only session updates should not become empty JSON chat bubbles.
  return [];
}

export function agentActivityText(content: string): string {
  return agentActivityDetails(content)
    .map((item) => item.text ?? [item.title, item.status].filter(Boolean).join(' · '))
    .filter(Boolean)
    .join('\n');
}

/** Preserve raw Nostr tags because the branch-loop UI projects lifecycle from them. */
export function toRigEvent(ev: BuzzSessionEvent): SessionEvent {
  if (ev.kind === 'agent-activity') {
    const activity = agentActivityDetails(ev.content);
    return {
      type: 'assistant_delta',
      sessionId: ev.channelId,
      id: ev.id,
      text: agentActivityText(ev.content),
      seq: ev.createdAt,
      pubkey: ev.pubkey,
      activity,
    };
  }
  if (ev.kind === 'message') {
    return {
      type: 'raw',
      sessionId: ev.channelId,
      payload: {
        id: ev.id,
        content: ev.content,
        pubkey: ev.pubkey,
        createdAt: ev.createdAt,
        tags: ev.event.tags,
      },
    };
  }
  return {
    type: 'raw',
    sessionId: ev.channelId,
    payload: ev.event,
  };
}

export type AgentTurnStatus = 'working' | 'complete' | 'failed';

export type ChatDisplayMessage = {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  pubkey?: string;
  isMergeSummary?: boolean;
  isArchivedNotice?: boolean;
  /**
   * A quiet, non-attributed system line rather than someone's turn. Two
   * sources: the client-only "you addressed an agent whose presence reads
   * offline/stale" notice (never published, never a relay event), and the
   * daemon's published `#t=steer-queued` acknowledgement that a message sent
   * mid-turn was received and will be delivered as the next prompt.
   */
  isSystemNotice?: boolean;
  /** True when the relay message is explicitly projected as an Agent answer. */
  isAgentAuthor?: boolean;
  isAgentActivity?: boolean;
  /**
   * True only while this bubble holds an in-flight `#t=agent-draft` stream,
   * not yet reconciled with the turn's final `agent-message`. Cleared the
   * moment the final reply lands (same `id`, see `agent-draft-${requestId}`).
   */
  isAgentDraft?: boolean;
  /**
   * The real relay event id, when it differs from `id`. A reconciled draft
   * bubble keeps a stable `agent-draft-${requestId}` display id across the
   * provisional → final transition, so reply-threading (which must target a
   * real signed event) reads this instead of `id`.
   */
  relayId?: string;
  activity?: AgentActivityItem[];
  attachments?: AttachmentReference[];
  /** NIP-10 event id of the message this conversational message replies to. */
  replyToId?: string;
  isNew?: boolean;
  corner?: {
    subchannelId: string;
    agentPubkey?: string;
    status: CornerStatus;
  };
  agentTurn?: {
    requestId: string;
    agentPubkey: string;
    status: AgentTurnStatus;
    generationId?: string;
  };
  /**
   * A daemon-published proposal to repoint this Room's landing target. The
   * agent may only ever *propose* — the binding itself is republished under a
   * confirming Room admin's own key (`roomTargetBranchSet`), and every reader
   * re-checks that author's current role.
   */
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
  /**
   * Branch/PR preview deployment for the merge-ready tip, when the repo's host
   * published one. Deliberately NOT a field on `MergeTarget`: that object is
   * the exact signed approval binding (repo/branch/tip) and must not grow a
   * cosmetic field a reviewer's signature would then be read as covering.
   */
  previewUrl?: string;
  clearMergeTarget?: boolean;
  archiveChannel?: boolean;
  /** A durable relay publish for this corner's own approved-merge delivery
   *  (push, land, or merge-gate attempt) failed or could not be confirmed.
   *  Lets the approve button stop showing a stale "sent" state while nothing
   *  is actually landing — see `apps/body/src/body.ts`'s corner-scoped
   *  `status=failed` body-control messages (no `subchannel` tag, since those
   *  are posted directly on this corner's own channel, not a parent Room
   *  status card). */
  deliveryFailed?: boolean;
  /** What is actually happening after that failure, straight from the daemon's
   *  `retry` tag — `auto` (the land poll really does re-attempt this same
   *  approval on its own), `realigning` (the corner's agent is rebasing onto
   *  the moved target and will republish a fresh review), or `blocked`
   *  (nothing happens until a person says something). Absent means the daemon
   *  did not say, and a client must then make NO retry claim at all. */
  deliveryRetry?: DeliveryRetryPosture;
  agentPresence?: AgentPresence;
};

/** Mirror of `apps/body/src/body.ts`'s `DeliveryRetryPosture`. */
export type DeliveryRetryPosture = 'auto' | 'realigning' | 'blocked';

const DELIVERY_RETRY_POSTURES: readonly string[] = ['auto', 'realigning', 'blocked'];

function deliveryRetryPosture(value: string | undefined): DeliveryRetryPosture | undefined {
  return value && DELIVERY_RETRY_POSTURES.includes(value)
    ? (value as DeliveryRetryPosture)
    : undefined;
}

export function sessionEventPayload(event: SessionEvent): UnknownRecord | undefined {
  return event.type === 'raw' ? asRecord(event.payload) : undefined;
}

export function sessionEventTags(event: SessionEvent): string[][] {
  const tags = sessionEventPayload(event)?.tags;
  return Array.isArray(tags)
    ? tags.filter(
        (tag): tag is string[] =>
          Array.isArray(tag) && tag.every((value) => typeof value === 'string'),
      )
    : [];
}

export function sessionEventTagValue(event: SessionEvent, name: string): string | undefined {
  return sessionEventTags(event).find((tag) => tag[0] === name)?.[1];
}

export function sessionEventHasTag(event: SessionEvent, name: string, value?: string): boolean {
  return sessionEventTags(event).some(
    (tag) => tag[0] === name && (value === undefined || tag[1] === value),
  );
}

/**
 * Every message body the transcript and the Room list ever show funnels through
 * here, which is why the percent-escape decode lives at this seam rather than
 * at each of the dozen render sites: `%3F` was reaching the slab literally
 * (`buzz/ledger-text.ts`).
 */
function eventText(event: SessionEvent): string {
  if (event.type === 'assistant_delta') return decodePercentEncoding(event.text);
  const content = sessionEventPayload(event)?.content;
  return typeof content === 'string' ? decodePercentEncoding(content) : '';
}

function eventPubkey(event: SessionEvent): string | undefined {
  if (event.type === 'assistant_delta') return event.pubkey;
  const pubkey = sessionEventPayload(event)?.pubkey;
  return typeof pubkey === 'string' ? pubkey : undefined;
}

function eventActivity(event: SessionEvent): AgentActivityItem[] | undefined {
  return event.type === 'assistant_delta' ? event.activity : undefined;
}

function eventTimestamp(event: SessionEvent): number {
  if (event.type === 'assistant_delta' && event.seq) return event.seq;
  const createdAt = sessionEventPayload(event)?.createdAt;
  return typeof createdAt === 'number' ? createdAt : Date.now();
}

function eventId(event: SessionEvent): string {
  if (event.type === 'assistant_delta' && event.id) return event.id;
  const id = sessionEventPayload(event)?.id;
  if (typeof id === 'string') return id;
  return `${event.type}-${eventTimestamp(event)}-${eventText(event).slice(0, 32)}`;
}

function cornerStatus(event: SessionEvent): CornerStatus | undefined {
  return mapRawCornerStatusTag(sessionEventTagValue(event, 'display-status') ?? sessionEventTagValue(event, 'status'));
}

/** One display projection for both initial backfill and live subscription events. */
export function projectChatEvent(
  event: SessionEvent,
  viewerPubkey: string,
  isNew = false,
): ChatEventProjection {
  const agentPresence = agentPresenceFromSessionEvent(event);
  if (agentPresence) return { agentPresence };
  // The streaming reply draft projects straight into the transcript as a
  // provisional bubble at the turn's stable id, so it fills in place and the
  // eventual final `agent-message` (matched by NIP-10 reply-to below) can
  // reconcile onto that same id instead of appearing as a second bubble.
  const agentDraft = agentDraftFromSessionEvent(event);
  if (agentDraft) {
    if (!agentDraft.text.trim()) return {};
    return {
      message: {
        id: `agent-draft-${agentDraft.requestId}`,
        // The streaming draft never passes through `eventText`, so it decodes
        // here or it is the one surface that still shows raw escapes.
        text: decodePercentEncoding(agentDraft.text),
        isUser: false,
        timestamp: Math.floor(agentDraft.observedAt / 1_000),
        pubkey: agentDraft.agentPubkey,
        isAgentAuthor: true,
        isAgentDraft: true,
      },
    };
  }
  const text = eventText(event);
  // A daemon state notice already on the relay (`retired-agent-notices.ts`).
  // The publisher is deleted, but the events remain and there is no tag to
  // recognize them by, so the whole sentence is the filter. Dropped before
  // anything else reads it: these carried a NIP-10 reply-to, so left in place
  // one of them would also claim a real turn's reconciled bubble id.
  if (isRetiredAgentStateNotice(text)) return {};
  const pubkey = eventPubkey(event);
  const subchannelId = sessionEventTagValue(event, 'subchannel');
  const bodyControl = sessionEventHasTag(event, 't', 'body-control') || Boolean(subchannelId);
  const status = cornerStatus(event);
  const isMergeSummary = sessionEventHasTag(event, 't', 'merge-summary');
  const isArchived = sessionEventHasTag(event, 'status', 'archived');
  // A corner's own delivery-failure notices (push/land/merge-gate failures)
  // are posted directly on the corner's own channel with no `subchannel`
  // tag — distinct from a `subchannel && status` parent-Room status card
  // (checked first below) and from the archive notice above.
  const isDeliveryFailure = bodyControl && !subchannelId && sessionEventHasTag(event, 'status', 'failed');
  // The daemon's quiet "your message is queued behind the running turn"
  // acknowledgement (`apps/body/src/activity.ts`'s `postSteerQueuedNotice`).
  // Deliberately NOT an `#t=agent-message`: it is a receipt for the human's
  // own input, not the agent speaking, so it renders as a system line and
  // never joins the agent's attributed voice run.
  const isSteerQueued = bodyControl && !subchannelId && sessionEventHasTag(event, 't', 'steer-queued');
  const repo = sessionEventTagValue(event, 'repo');
  const branch = sessionEventTagValue(event, 'branch');
  const tip = sessionEventTagValue(event, 'tip');
  const isMergeReady = sessionEventHasTag(event, 't', 'merge-ready');
  const mergeTarget = isMergeReady && repo && branch && tip ? { repo, branch, tip } : undefined;
  // Only ever an https link the daemon read off the repo host; anything else
  // is dropped rather than rendered as a tappable row.
  const previewCandidate = sessionEventTagValue(event, 'preview');
  const previewUrl =
    mergeTarget && previewCandidate && /^https:\/\/[^\s]+$/i.test(previewCandidate)
      ? previewCandidate
      : undefined;
  const permissionId = sessionEventTagValue(event, 'permission');
  const permissionRequestId = sessionEventTagValue(event, 'request');
  const permissionAgent = sessionEventTagValue(event, 'agent') ?? sessionEventTagValue(event, 'p');
  const isPermissionRequest = sessionEventHasTag(event, 't', 'buzz-write-permission-request');
  const isPermissionResponse = sessionEventHasTag(event, 't', 'buzz-write-permission-response');
  const isAgentTurn = sessionEventHasTag(event, 't', 'agent-turn');
  const attachments = parseAttachmentTags(sessionEventTags(event));
  const replyToId = sessionEventTags(event).find(
    (tag) => tag[0] === 'e' && tag[1] && tag[3] === 'reply',
  )?.[1];

  if (isAgentTurn) {
    const requestId = sessionEventTagValue(event, 'request');
    const agentPubkey = sessionEventTagValue(event, 'agent') ?? pubkey;
    const turnStatus = sessionEventTagValue(event, 'status');
    const generationId = sessionEventTagValue(event, 'generation');
    if (
      requestId &&
      agentPubkey &&
      (turnStatus === 'working' || turnStatus === 'complete' || turnStatus === 'failed')
    ) {
      return {
        message: {
          id: `agent-turn-${requestId}`,
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          pubkey: agentPubkey,
          agentTurn: {
            requestId,
            agentPubkey,
            status: turnStatus,
            ...(generationId ? { generationId } : {}),
          },
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    return {};
  }

  // A response is proposed human intent. Body verifies current membership and
  // human identity, then emits the authoritative request-status projection.
  if (isPermissionResponse) return {};

  if (permissionId && permissionRequestId && permissionAgent && isPermissionRequest) {
    const wireStatus = sessionEventTagValue(event, 'status');
    const status =
      wireStatus === 'allowed'
        ? 'allowed'
        : wireStatus === 'denied'
          ? 'denied'
          : wireStatus === 'expired'
            ? 'expired'
            : wireStatus === 'failed'
              ? 'failed'
              : 'pending';
    return {
      message: {
        id: `write-permission-${permissionId}`,
        text,
        isUser: false,
        timestamp: eventTimestamp(event),
        ...(pubkey ? { pubkey } : {}),
        writePermission: {
          permissionId,
          requestId: permissionRequestId,
          agentPubkey: permissionAgent,
          tool: sessionEventTagValue(event, 'tool') ?? 'edit files',
          ...(repo ? { repository: repo } : {}),
          status,
          ...(subchannelId ? { subchannelId } : {}),
        },
        ...(isNew ? { isNew: true } : {}),
      },
    };
  }
  if (
    sessionEventHasTag(event, 't', 'change-review-manifest') ||
    sessionEventHasTag(event, 't', 'change-review-file')
  ) {
    return {};
  }
  if (event.type === 'assistant_delta' && !text.trim()) return {};

  if (isMergeSummary) {
    return {
      ...(mergeTarget ? { mergeTarget } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      message: {
        id: eventId(event),
        text,
        isUser: false,
        timestamp: eventTimestamp(event),
        ...(pubkey ? { pubkey } : {}),
        isMergeSummary: true,
        ...(isNew ? { isNew: true } : {}),
      },
    };
  }

  if (bodyControl) {
    const clearMergeTarget = sessionEventHasTag(event, 't', 'merge-not-ready');
    // A daemon-published proposal to repoint the Room's landing target. It is
    // rendered as a card because it is exactly what DESIGN.md's Shape rule
    // admits a box for: something the reader must find and act on.
    if (sessionEventHasTag(event, 't', 'buzz-target-branch-proposal')) {
      const from = sessionEventTagValue(event, 'from');
      const to = sessionEventTagValue(event, 'to');
      if (!from || !to) return {};
      return {
        message: {
          id: `target-branch-${eventId(event)}`,
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          ...(pubkey ? { pubkey } : {}),
          targetBranchProposal: {
            proposalId: eventId(event),
            from,
            to,
            ...(repo ? { repository: repo } : {}),
            ...(sessionEventTagValue(event, 'agent') ?? pubkey
              ? { agentPubkey: sessionEventTagValue(event, 'agent') ?? pubkey }
              : {}),
            ...(sessionEventTagValue(event, 'requester')
              ? { requesterPubkey: sessionEventTagValue(event, 'requester')! }
              : {}),
          },
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    if (subchannelId && status) {
      return {
        ...(mergeTarget ? { mergeTarget } : {}),
        ...(previewUrl ? { previewUrl } : {}),
        ...(clearMergeTarget ? { clearMergeTarget: true } : {}),
        message: {
          id: `corner-${subchannelId}`,
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          ...(pubkey ? { pubkey } : {}),
          corner: {
            subchannelId,
            agentPubkey: sessionEventTagValue(event, 'agent') ?? pubkey,
            status,
          },
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    if (isArchived && !subchannelId) {
      return {
        archiveChannel: true,
        message: {
          id: eventId(event),
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          ...(pubkey ? { pubkey } : {}),
          isArchivedNotice: true,
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    if (isSteerQueued) {
      return {
        message: {
          id: eventId(event),
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          ...(pubkey ? { pubkey } : {}),
          isSystemNotice: true,
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    if (isDeliveryFailure) {
      // Previously dropped entirely (no `message`) — the relay durably had
      // the failure but the transcript never showed it and the approve
      // button never learned about it either.
      const deliveryRetry = deliveryRetryPosture(sessionEventTagValue(event, 'retry'));
      return {
        ...(mergeTarget ? { mergeTarget } : {}),
        ...(previewUrl ? { previewUrl } : {}),
        deliveryFailed: true,
        ...(deliveryRetry ? { deliveryRetry } : {}),
        message: {
          id: eventId(event),
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          ...(pubkey ? { pubkey } : {}),
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    return {
      ...(mergeTarget ? { mergeTarget } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      ...(clearMergeTarget ? { clearMergeTarget: true } : {}),
      ...(isArchived && !subchannelId ? { archiveChannel: true } : {}),
    };
  }

  // A Room/DM turn's final reply always answers the human's own request
  // event (`replyTo`), the same id Body threads as the draft/turn `request`
  // tag. Reconcile onto the draft's stable bubble id so the final text
  // updates the SAME on-screen bubble in place rather than appending a new
  // one — the raw relay event id survives in `relayId` so reply-threading
  // (which must reference a real signed event) keeps working.
  const isAgentMessage = sessionEventHasTag(event, 't', 'agent-message');
  const relayId = eventId(event);
  const reconciledId = isAgentMessage && replyToId ? `agent-draft-${replyToId}` : undefined;

  return {
    ...(mergeTarget ? { mergeTarget } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    message: {
      id: reconciledId ?? relayId,
      ...(reconciledId ? { relayId } : {}),
      text,
      isUser: pubkey === viewerPubkey,
      timestamp: eventTimestamp(event),
      ...(pubkey ? { pubkey } : {}),
      ...(isAgentMessage ? { isAgentAuthor: true } : {}),
      ...(event.type === 'assistant_delta' ? { isAgentActivity: true } : {}),
      ...(eventActivity(event)?.length ? { activity: eventActivity(event) } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(replyToId ? { replyToId } : {}),
      ...(isNew ? { isNew: true } : {}),
    },
  };
}

/**
 * The messages a transcript actually renders, for either surface.
 *
 * Both surfaces run one loop, because tool telemetry is now collapsed the same
 * way on both: consecutive activity events fold into one entry, which the UI
 * renders as a single dim, expandable line rather than a wall of output
 * (DESIGN.md, "Machine noise"). An activity event carrying no projected
 * activity is still dropped outright on both — there is nothing to disclose.
 *
 * A Room additionally hides Corner-scoped lifecycle cards (merge summaries,
 * archive notices, turn lifecycle) that belong to a Corner's own transcript,
 * keeping its own compact Corner card instead.
 */
/**
 * Whether an activity batch has anything a reader can see.
 *
 * Body publishes a plan change on its own `activity_summary` event so the
 * corner's pinned objective panel costs no extra relay write. That event
 * carries nothing else — no label, no counts, no receipts — and its plan is
 * read straight off the raw message list by `latestCornerPlan`, never from
 * this transcript. Keeping it here would spend an initial-window slot on a
 * FlatList cell that renders nothing (`ActivityTimeline` returns null), which
 * is the same silent-empty-row failure a corner status card once had.
 */
function hasVisibleActivity(items: readonly AgentActivityItem[]): boolean {
  return items.some(
    (item) =>
      item.kind !== 'summary' ||
      Boolean(item.text) ||
      Boolean(item.rollup) ||
      Boolean(item.observed?.length) ||
      Boolean(item.thoughtMs),
  );
}

export function transcriptMessages(
  messages: ChatDisplayMessage[],
  isCorner: boolean,
): ChatDisplayMessage[] {
  const transcript: ChatDisplayMessage[] = [];
  let activityRunOpen = false;
  for (const message of messages) {
    // Lifecycle is presentation state, not a blank conversational message,
    // but it remains a hard turn boundary for the activity on either side.
    if (message.agentTurn) {
      activityRunOpen = false;
      continue;
    }
    // A corner's status is never inscribed into a transcript, on either
    // surface: the pinned line above the composer owns it while it is live,
    // and the Room's corners view owns it once it is not. Dropping it *here*
    // rather than returning null from `renderItem` is the load-bearing part —
    // a null-rendering row still occupies a FlatList cell and still spends the
    // initial message window, so a Room with a long corner history opened
    // half-empty. It stays a hard turn boundary, like lifecycle above.
    if (message.corner) {
      activityRunOpen = false;
      continue;
    }
    if (!isCorner && (message.isMergeSummary || message.isArchivedNotice)) {
      activityRunOpen = false;
      continue;
    }

    if (message.isAgentActivity) {
      if (!message.activity?.length || !hasVisibleActivity(message.activity)) {
        activityRunOpen = false;
        continue;
      }
      const previous = transcript.at(-1);
      if (activityRunOpen && previous?.isAgentActivity) {
        previous.activity = [...(previous.activity ?? []), ...message.activity];
        // Keep the first event id stable while the live run grows. Never join
        // prose here: final messages and user messages remain hard boundaries.
        continue;
      }
      activityRunOpen = true;
    } else {
      activityRunOpen = false;
    }
    transcript.push({
      ...message,
      ...(message.activity ? { activity: [...message.activity] } : {}),
    });
  }
  return transcript;
}

const AGENT_TURN_STATUS_ORDER: Record<AgentTurnStatus, number> = {
  working: 0,
  complete: 1,
  failed: 1,
};

const WRITE_PERMISSION_STATUS_ORDER: Record<
  NonNullable<ChatDisplayMessage['writePermission']>['status'],
  number
> = {
  pending: 0,
  allowed: 1,
  denied: 1,
  expired: 1,
  failed: 2,
};

/** Stable-id upsert keeps lifecycle cards monotonic across replay order. */
export function upsertChatMessages(
  current: ChatDisplayMessage[],
  incoming: ChatDisplayMessage[],
): ChatDisplayMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (let message of incoming) {
    const existing = byId.get(message.id);
    // The draft stream and the final `agent-message` arrive over independent
    // relay subscriptions with no ordering guarantee between them. Once a
    // bubble has been finalized, a late-delivered draft flush for the same
    // request must never regress it back to provisional streaming text.
    if (existing && !existing.isAgentDraft && message.isAgentDraft) {
      continue;
    }
    // Two DIFFERENT agent messages must never share one bubble.
    //
    // A `#t=agent-message` that carries a NIP-10 reply-to claims the stable
    // `agent-draft-<parent>` id so a streaming draft can become the final text
    // in place. But a turn can publish more than one message answering the
    // same request — the honest "still working on this" stall notice and then
    // the reply itself, which is 13 of 50 reply-parents in the captain's Room
    // — and each later one silently REPLACED the earlier. Reconciliation is
    // for a draft becoming final; anything else keeps its own event id and its
    // own bubble. A redelivery of the same event still updates in place,
    // because it carries the same `relayId`.
    if (
      existing &&
      !existing.isAgentDraft &&
      !message.isAgentDraft &&
      message.relayId &&
      (existing.relayId ?? existing.id) !== message.relayId
    ) {
      message = { ...message, id: message.relayId };
    }
    if (
      existing?.corner &&
      message.corner &&
      cornerStatusPrecedence(message.corner.status) < cornerStatusPrecedence(existing.corner.status)
    ) {
      continue;
    }
    if (
      existing?.agentTurn &&
      message.agentTurn &&
      AGENT_TURN_STATUS_ORDER[message.agentTurn.status] <
        AGENT_TURN_STATUS_ORDER[existing.agentTurn.status]
    ) {
      continue;
    }
    if (existing?.writePermission && message.writePermission) {
      if (
        WRITE_PERMISSION_STATUS_ORDER[message.writePermission.status] <
        WRITE_PERMISSION_STATUS_ORDER[existing.writePermission.status]
      ) {
        continue;
      }
      message = {
        ...message,
        writePermission: {
          ...message.writePermission,
          tool:
            message.writePermission.tool === 'edit files'
              ? existing.writePermission.tool
              : message.writePermission.tool,
          subchannelId:
            message.writePermission.subchannelId ?? existing.writePermission.subchannelId,
        },
      };
    }
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}
