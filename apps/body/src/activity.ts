/**
 * Activity projection: subscribe to the edit session's ACP `session/update`
 * stream and project tool_call/message chunks as channel events every member
 * can see (kind:9 + #t=agent-activity tag).
 *
 * This is what makes "watch the agent work, together" real — the body bridges
 * the stdio-local ACP stream into the relay channel so all members receive live
 * agent activity.
 */
import { randomUUID } from 'node:crypto';
import type { AcpClient, SessionUpdate } from './acp.js';
import type { Identity } from '@beeline/gate';
import { publishEvent } from '@beeline/gate';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  AGENT_PRESENCE_HEARTBEAT_MS,
  KIND_AGENT_PRESENCE,
  TAG_AGENT_PRESENCE,
  buildAttachmentTags,
  type AgentPresenceStatus,
  type AttachmentReference,
} from '@beeline/buzz-client';
import { sanitizeActivityUpdate } from './attachments.js';

export const ACTIVITY_TAG = 'agent-activity';
export const AGENT_MESSAGE_TAG = 'agent-message';
export const AGENT_TURN_TAG = 'agent-turn';

/**
 * ACP tool-call kinds that are always load-bearing: they change the worktree
 * (or a PR/branch derived from it) regardless of what command produced them.
 */
const LOAD_BEARING_TOOL_KINDS = new Set(['edit', 'delete', 'move']);
/** ACP tool-call kinds that are inherently background inspection, never surfaced alone. */
const LOW_SIGNAL_TOOL_KINDS = new Set(['read', 'search', 'think', 'fetch', 'other']);
/** `session/update` kinds that are reasoning/planning/metadata noise, never projected. */
const SUPPRESSED_SESSION_UPDATE_KINDS = new Set([
  'agent_thought_chunk',
  'agent_thought',
  'plan',
  'user_message_chunk',
  'available_commands_update',
  'current_mode_update',
]);
/** Shell commands that stay inspection-only even when routed through an 'execute' tool call. */
const INSPECTION_COMMAND =
  /^\s*(?:grep|rg|ag|find|sed\s+-n|cat|head|tail|ls|pwd|wc|file|which|type)\b|^\s*git\s+(?:status|diff|log|show|branch)\b/i;
const MAX_SUMMARY_ACTIONS = 6;
const MAX_SUMMARY_LENGTH = 500;

interface ToolCallInfo {
  kind?: string;
  title?: string;
  command?: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function commandText(rawInput: unknown): string | undefined {
  const record = objectValue(rawInput);
  const command = record?.command ?? record?.cmd;
  return typeof command === 'string' ? command : undefined;
}

function toolCallInfo(update: Record<string, unknown>): ToolCallInfo {
  return {
    kind: typeof update.kind === 'string' ? update.kind : undefined,
    title: typeof update.title === 'string' ? update.title : undefined,
    command: commandText(update.rawInput),
  };
}

/** True once a tool call is load-bearing enough to show as its own transcript line. */
function isLoadBearingToolCall(info: ToolCallInfo): boolean {
  if (info.kind && LOAD_BEARING_TOOL_KINDS.has(info.kind)) return true;
  if (info.kind && LOW_SIGNAL_TOOL_KINDS.has(info.kind)) return false;
  // 'execute' (and any kind an older agent omits) covers everything from a
  // grep to a test-suite run or `gh pr create` — only the former is noise.
  return !INSPECTION_COMMAND.test(info.command ?? info.title ?? '');
}

/** Remember the kind/title/command a toolCallId announced, since a terminal
 *  `tool_call_update` delta often omits everything except id + status. */
function trackToolCall(
  update: Record<string, unknown>,
  toolCallKinds: Map<string, ToolCallInfo>,
): void {
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
  if (!toolCallId) return;
  const info = toolCallInfo(update);
  if (!info.kind && !info.title && !info.command) return;
  const existing = toolCallKinds.get(toolCallId);
  toolCallKinds.set(toolCallId, {
    kind: info.kind ?? existing?.kind,
    title: info.title ?? existing?.title,
    command: info.command ?? existing?.command,
  });
}

/**
 * True only for a *terminal* update the captain cares about: a completed
 * load-bearing tool call (an edit, a test run, a commit, a PR) or any failed
 * tool call (a blocker). Pending/in-progress tool chatter, reasoning, and
 * planning steps never qualify — they stay background telemetry.
 */
function isMajorUpdate(
  update: Record<string, unknown>,
  toolCallKinds: Map<string, ToolCallInfo>,
): boolean {
  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
  if (!sessionUpdate || SUPPRESSED_SESSION_UPDATE_KINDS.has(sessionUpdate)) return false;
  if (
    sessionUpdate !== 'tool_call' &&
    sessionUpdate !== 'tool_call_update' &&
    sessionUpdate !== 'tool_result'
  ) {
    return false;
  }
  const status =
    typeof update.status === 'string'
      ? update.status
      : sessionUpdate === 'tool_result'
        ? 'completed'
        : undefined;
  if (status !== 'completed' && status !== 'failed') return false;
  if (status === 'failed') return true;
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
  const known = toolCallId ? toolCallKinds.get(toolCallId) : undefined;
  const info = toolCallInfo(update);
  return isLoadBearingToolCall({
    kind: info.kind ?? known?.kind,
    title: info.title ?? known?.title,
    command: info.command ?? known?.command,
  });
}

/** Short "Edited x.ts" / "Failed: npm test" label for the turn's summary line. */
function describeMajorUpdate(
  update: Record<string, unknown>,
  toolCallKinds: Map<string, ToolCallInfo>,
): string {
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
  const known = toolCallId ? toolCallKinds.get(toolCallId) : undefined;
  const info = toolCallInfo(update);
  const label = info.title ?? known?.title ?? info.command ?? known?.command ?? 'tool call';
  return update.status === 'failed' ? `Failed: ${label}` : label;
}

/** Concise summary line appended after a batch's major actions. */
function summarizeMajorActions(labels: readonly string[]): string {
  const shown = labels.slice(0, MAX_SUMMARY_ACTIONS);
  const omitted = labels.length - shown.length;
  const summary = `${shown.join('; ')}${omitted > 0 ? ` (+${omitted} more)` : ''}`;
  return summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : summary;
}

export type AgentPresenceController = (() => Promise<void>) & {
  generationId: string;
  /** Immediately publish a new availability state and use it for later heartbeats. */
  setStatus(status: AgentPresenceStatus): Promise<void>;
};

const CODEX_HARNESS_NOTICE =
  /^(?:⚠(?:️)?\s*)?(?:warning|notice):\s*(?:skill|tool|plugin) descriptions?\b.*\b(?:context budget|budget limit)\b/i;
const CODEX_HARNESS_NOTICE_CONTINUATION =
  /^(?:codex can still (?:see|access|read)|(?:use|open|read)\s+\S*skill\.md\b)/i;

/** Remove only the known leading Codex startup warning, never mid-reply text. */
export function stripAgentReplyPreamble(message: string): string {
  const lines = message.split(/\r?\n/);
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  if (firstContent < 0 || !CODEX_HARNESS_NOTICE.test(lines[firstContent]!.trim())) {
    return message;
  }
  let replyStart = firstContent + 1;
  while (
    replyStart < lines.length &&
    (!lines[replyStart]!.trim() ||
      CODEX_HARNESS_NOTICE_CONTINUATION.test(lines[replyStart]!.trim()) ||
      CODEX_HARNESS_NOTICE.test(lines[replyStart]!.trim()))
  ) {
    replyStart++;
  }
  return lines.slice(replyStart).join('\n');
}

/** Batched activity to emit as a single channel event. */
export interface ActivityBatch {
  sessionId: string;
  channelId: string;
  events: SessionUpdate[];
}

/**
 * Project ACP session/update notifications into channel events.
 * Returns an unsubscribe function.
 */
export function projectActivity(
  client: AcpClient,
  channelId: string,
  channelOwner: Identity,
  sessionId: string,
): () => void {
  let pending: SessionUpdate[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const toolCallKinds = new Map<string, ToolCallInfo>();
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const events = pending;
    pending = [];
    if (!events.length) return;
    // Batch first, then keep only the major load-bearing actions — an edit, a
    // completed test/build/PR command, or a failure — so the projected
    // transcript reads like a clean assistant log, not raw tool telemetry.
    const major: SessionUpdate[] = [];
    const labels: string[] = [];
    for (const event of events) {
      if (!isMajorUpdate(event.update, toolCallKinds)) continue;
      major.push(event);
      labels.push(describeMajorUpdate(event.update, toolCallKinds));
      const toolCallId =
        typeof event.update.toolCallId === 'string' ? event.update.toolCallId : undefined;
      if (toolCallId) toolCallKinds.delete(toolCallId);
    }
    if (!major.length) return;
    const summary: SessionUpdate = {
      sessionId,
      update: {
        sessionUpdate: 'activity_summary',
        content: { type: 'text', text: summarizeMajorActions(labels) },
      },
    };
    void emitActivityEvent(channelId, channelOwner, {
      sessionId,
      channelId,
      events: [...major, summary],
    });
  };
  const onUpdate = (u: SessionUpdate) => {
    if (u.sessionId !== sessionId) return;
    // Assistant prose is published once, as a first-class channel message,
    // after sessionPrompt completes. Keep the activity stream for thought/tool
    // telemetry so conversation copy cannot be duplicated or lost in a batch.
    if (u.update.sessionUpdate === 'agent_message_chunk') return;
    const sanitized = sanitizeActivityUpdate(u.update);
    trackToolCall(sanitized, toolCallKinds);
    pending.push({ ...u, update: sanitized });
    // One paired identity can serve several Rooms. A five-second batch keeps
    // shared live visibility while staying below per-pubkey relay quotas under
    // concurrent tool-call bursts.
    timer ??= setTimeout(flush, 5_000);
  };

  client.on('session/update', onUpdate);
  return () => {
    client.off('session/update', onUpdate);
    flush();
  };
}

/** Publish a completed assistant turn as durable conversation, not telemetry. */
export function buildAgentMessage(
  channelId: string,
  owner: Identity,
  message: string,
  replyTo?: string,
  attachments: readonly AttachmentReference[] = [],
  extraTags: readonly string[][] = [],
): NostrEvent {
  return signEvent(
    {
      pubkey: owner.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 9,
      tags: [
        ['h', channelId],
        ['t', AGENT_MESSAGE_TAG],
        ...(replyTo ? [['e', replyTo, '', 'reply']] : []),
        ...buildAttachmentTags(attachments),
        ...extraTags,
      ],
      content: message,
    },
    owner.secretKey,
  );
}

export async function postAgentMessage(
  channelId: string,
  owner: Identity,
  message: string,
  replyTo?: string,
  attachments: readonly AttachmentReference[] = [],
  extraTags: readonly string[][] = [],
): Promise<void> {
  await publishEvent(
    buildAgentMessage(channelId, owner, message, replyTo, attachments, extraTags),
    owner,
  );
}

/** Publish the read-only Room turn lifecycle used by the thinking indicator. */
export function postAgentTurnStatus(
  channelId: string,
  owner: Identity,
  requestId: string,
  sessionId: string,
  status: 'working' | 'complete' | 'failed',
  generationId?: string,
): Promise<void> {
  const message =
    status === 'working'
      ? 'Agent is thinking…'
      : status === 'complete'
        ? 'Agent reply complete.'
        : 'Agent reply stopped.';
  return postControlMessage(channelId, owner, message, [
    ['t', AGENT_TURN_TAG],
    ['request', requestId],
    ['session', sessionId],
    ['agent', owner.publicKey],
    ['mode', 'readonly'],
    ['status', status],
    ...(generationId ? [['generation', generationId]] : []),
  ]);
}

/** Publish one signed, replaceable Room-scoped daemon presence marker. */
export async function postAgentPresence(
  channelId: string,
  owner: Identity,
  status: AgentPresenceStatus,
  createdAt = Math.floor(Date.now() / 1_000),
  generationId?: string,
): Promise<void> {
  const event: NostrEvent = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: createdAt,
      kind: KIND_AGENT_PRESENCE,
      tags: [
        ['d', `agent-presence:${channelId}`],
        ['h', channelId],
        ['t', TAG_AGENT_PRESENCE],
        ['agent', owner.publicKey],
        ['status', status],
        ...(generationId ? [['generation', generationId]] : []),
      ],
      content: status,
    },
    owner.secretKey,
  );
  await publishEvent(event, owner);
}

/**
 * Start a low-rate heartbeat. Publishes immediately and serializes refreshes so
 * a slow relay cannot create overlapping requests. The returned stop function
 * emits an offline marker after any in-flight heartbeat settles.
 */
export function startAgentPresence(
  channelId: string,
  owner: Identity,
  intervalMs = AGENT_PRESENCE_HEARTBEAT_MS,
  onPublished?: (status: AgentPresenceStatus) => void,
): AgentPresenceController {
  let stopped = false;
  let lastCreatedAt = 0;
  let chain = Promise.resolve();
  let status: AgentPresenceStatus = 'online';
  const generationId = randomUUID();
  const enqueue = (nextStatus: AgentPresenceStatus) => {
    const createdAt = Math.max(Math.floor(Date.now() / 1_000), lastCreatedAt + 1);
    lastCreatedAt = createdAt;
    chain = chain
      .then(() => postAgentPresence(channelId, owner, nextStatus, createdAt, generationId))
      .then(() => onPublished?.(nextStatus))
      .catch((error) => console.error(`[body] agent presence ${nextStatus} failed:`, error));
    return chain;
  };

  void enqueue(status);
  const timer = setInterval(() => {
    if (!stopped) void enqueue(status);
  }, intervalMs);
  timer.unref?.();

  const setStatus = (nextStatus: AgentPresenceStatus) => {
    status = nextStatus;
    return enqueue(status);
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await chain;
    const createdAt = Math.max(Math.floor(Date.now() / 1_000), lastCreatedAt + 1);
    await postAgentPresence(channelId, owner, 'offline', createdAt, generationId)
      .then(() => onPublished?.('offline'))
      .catch((error) => console.error('[body] agent presence offline failed:', error));
  };
  return Object.assign(stop, { generationId, setStatus });
}

/** Emit an ordered batch of session updates as one kind:9 channel event. */
async function emitActivityEvent(
  channelId: string,
  owner: Identity,
  batch: ActivityBatch,
): Promise<void> {
  try {
    const content = JSON.stringify({
      sessionId: batch.sessionId,
      update: {
        sessionUpdate: 'activity_batch',
        updates: batch.events.map((event) => event.update),
      },
      projected: true,
    });

    const event: NostrEvent = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ['h', channelId],
          ['t', ACTIVITY_TAG],
          ['session', batch.sessionId],
        ],
        content,
      },
      owner.secretKey,
    );

    await publishEvent(event, owner);
  } catch (err) {
    // Log but don't crash the body — activity projection is best-effort.
    console.error('[body] activity projection error:', err);
  }
}

/**
 * Post a control message to a channel (kind:9 with specific tag).
 * Used for: "subchannel opened", "session started", "session archived", etc.
 */
export async function postControlMessage(
  channelId: string,
  owner: Identity,
  msg: string,
  extraTags: string[][] = [],
): Promise<void> {
  const event: NostrEvent = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 9,
      tags: [['h', channelId], ['t', 'body-control'], ...extraTags],
      content: msg,
    },
    owner.secretKey,
  );

  await publishEvent(event, owner);
}
