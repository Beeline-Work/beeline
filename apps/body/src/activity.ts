/**
 * Activity projection: subscribe to the edit session's ACP `session/update`
 * stream and project compact, inspectable turn details as channel events every
 * member can see (kind:9 + #t=agent-activity tag).
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
  events: Record<string, unknown>[];
}

export interface CompactActivityFile {
  path: string;
  status?: string;
  diff?: string;
}

export interface CompactActivityPlanItem {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface CompactActivityPlan {
  objective?: string;
  items: CompactActivityPlanItem[];
}

const MAX_ACTIVITY_DETAIL_CHARS = 12_000;
const MAX_ACTIVITY_INPUT_CHARS = 4_000;
const SENSITIVE_ACTIVITY_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key)/i;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactText(
  value: unknown,
  limit = MAX_ACTIVITY_DETAIL_CHARS,
  depth = 0,
): string | undefined {
  if (depth > 5 || value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n… output truncated` : trimmed;
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => compactText(item, limit, depth + 1))
      .filter((item): item is string => Boolean(item))
      .join('\n');
    return compactText(joined, limit, depth + 1);
  }
  const record = objectValue(value);
  if (!record) return compactText(String(value), limit, depth + 1);
  if (typeof record.text === 'string') return compactText(record.text, limit, depth + 1);
  if ('content' in record) return compactText(record.content, limit, depth + 1);
  try {
    return compactText(JSON.stringify(record), limit, depth + 1);
  } catch {
    return undefined;
  }
}

function redactedInput(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested value omitted]';
  if (Array.isArray(value)) return value.map((item) => redactedInput(item, depth + 1));
  const record = objectValue(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      SENSITIVE_ACTIVITY_KEY.test(key) ? '[redacted]' : redactedInput(item, depth + 1),
    ]),
  );
}

function compactInput(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return compactText(JSON.stringify(redactedInput(value), null, 2), MAX_ACTIVITY_INPUT_CHARS);
  } catch {
    return undefined;
  }
}

function planStatus(value: unknown): CompactActivityPlanItem['status'] {
  if (value === 'completed' || value === 'complete' || value === 'done') return 'completed';
  if (value === 'in_progress' || value === 'active' || value === 'working') return 'in_progress';
  return 'pending';
}

function activityPlan(...sources: unknown[]): CompactActivityPlan | undefined {
  for (const source of sources) {
    const record = objectValue(source);
    if (!record) continue;
    const planValue = record.plan;
    const rawItems = Array.isArray(planValue)
      ? planValue
      : Array.isArray(objectValue(planValue)?.items)
        ? (objectValue(planValue)!.items as unknown[])
        : Array.isArray(record.items)
          ? record.items
          : [];
    const items = rawItems
      .map((item) => {
        const entry = objectValue(item);
        const step = compactText(entry?.step ?? entry?.text ?? entry?.title, 240);
        return step ? { step, status: planStatus(entry?.status) } : undefined;
      })
      .filter((item): item is CompactActivityPlanItem => Boolean(item));
    const planRecord = objectValue(planValue);
    const objective = compactText(record.objective ?? planRecord?.objective, 320);
    if (items.length || objective) return { ...(objective ? { objective } : {}), items };
  }
  return undefined;
}

function activityFiles(...sources: unknown[]): CompactActivityFile[] {
  const files = new Map<string, CompactActivityFile>();
  const addPatchFiles = (value: string) => {
    const matches = [
      ...value.matchAll(
        /^(?:diff --git a\/(.+?) b\/(.+)|\*\*\* (Update|Add|Delete) File: (.+))\s*$/gm,
      ),
    ];
    matches.forEach((match, index) => {
      const path = match[2] ?? match[4];
      if (!path) return;
      const diff = compactText(
        value.slice(match.index, matches[index + 1]?.index ?? value.length),
        MAX_ACTIVITY_DETAIL_CHARS,
      );
      const operation = match[3]?.toLowerCase();
      files.set(path, {
        path,
        ...(operation
          ? {
              status:
                operation === 'add' ? 'added' : operation === 'delete' ? 'deleted' : 'modified',
            }
          : {}),
        ...(diff ? { diff } : {}),
      });
    });
  };
  const visit = (value: unknown, depth = 0) => {
    if (depth > 5) return;
    if (typeof value === 'string') {
      addPatchFiles(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const record = objectValue(value);
    if (!record) return;
    const path = compactText(record.path ?? record.filePath ?? record.file ?? record.filename, 500);
    if (path) {
      const existing = files.get(path);
      const oldText = compactText(record.oldText ?? record.old_string, MAX_ACTIVITY_DETAIL_CHARS);
      const newText = compactText(record.newText ?? record.new_string, MAX_ACTIVITY_DETAIL_CHARS);
      const replacementDiff =
        oldText !== undefined || newText !== undefined
          ? [
              `--- ${path}`,
              `+++ ${path}`,
              ...(oldText ?? '').split('\n').map((line) => `-${line}`),
              ...(newText ?? '').split('\n').map((line) => `+${line}`),
            ].join('\n')
          : undefined;
      const diff = compactText(
        record.diff ?? record.patch ?? replacementDiff,
        MAX_ACTIVITY_DETAIL_CHARS,
      );
      const status = compactText(record.status ?? record.operation, 40);
      files.set(path, {
        path,
        ...(existing?.status || status ? { status: status ?? existing?.status } : {}),
        ...(existing?.diff || diff ? { diff: diff ?? existing?.diff } : {}),
      });
    }
    for (const key of [
      'files',
      'edits',
      'changes',
      'locations',
      'content',
      'rawOutput',
      'result',
    ]) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  sources.forEach((source) => visit(source));
  return [...files.values()].slice(0, 32);
}

/** Convert an ACP update into the small, durable record needed by the corner drill-down. */
export function compactActivityUpdate(
  update: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  if (
    !sessionUpdate ||
    sessionUpdate === 'agent_message_chunk' ||
    sessionUpdate.includes('thought') ||
    sessionUpdate.includes('thinking') ||
    sessionUpdate.includes('reasoning')
  ) {
    return undefined;
  }

  const toolCall = objectValue(update.toolCall);
  const rawInput = update.rawInput ?? toolCall?.rawInput;
  const title = compactText(update.title ?? toolCall?.title, 240);
  const kind = compactText(update.kind ?? toolCall?.kind, 80);
  const status = compactText(update.status ?? toolCall?.status, 80);
  const toolCallId = compactText(update.toolCallId ?? toolCall?.toolCallId ?? update.id, 160);
  const plan = activityPlan(update, rawInput, toolCall);

  if (
    sessionUpdate === 'tool_call' ||
    sessionUpdate === 'tool_call_update' ||
    sessionUpdate === 'tool_result' ||
    plan
  ) {
    const inputRecord = objectValue(rawInput);
    const command = compactText(
      inputRecord?.command ?? inputRecord?.cmd ?? inputRecord?.script ?? update.command,
      MAX_ACTIVITY_INPUT_CHARS,
    );
    const output = compactText(
      update.output ?? update.rawOutput ?? update.result ?? update.content ?? toolCall?.output,
    );
    const files = activityFiles(rawInput, update, toolCall);
    if (files.length === 1 && !files[0]!.diff && output?.startsWith('diff --git ')) {
      files[0] = { ...files[0]!, diff: output };
    }
    return {
      sessionUpdate: 'tool_activity',
      ...(toolCallId ? { toolCallId } : {}),
      ...(title ? { title } : {}),
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(command ? { command } : {}),
      ...(rawInput !== undefined ? { input: compactInput(rawInput) } : {}),
      ...(output ? { output } : {}),
      ...(files.length ? { files } : {}),
      ...(plan ? { plan } : {}),
    };
  }

  const text = stripAgentReplyPreamble(
    compactText(update.content ?? update.message ?? update.output, 2_000) ?? '',
  ).trim();
  return text ? { sessionUpdate: 'progress_update', text } : undefined;
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
  let pending: Record<string, unknown>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const events = pending;
    pending = [];
    if (events.length)
      void emitActivityEvent(channelId, channelOwner, { sessionId, channelId, events });
  };
  const onUpdate = (u: SessionUpdate) => {
    if (u.sessionId !== sessionId) return;
    // Assistant prose is published once, as a first-class channel message,
    // after sessionPrompt completes. The compact activity stream keeps progress
    // and inspectable tool facts, while private reasoning never reaches Rooms.
    const compact = compactActivityUpdate(sanitizeActivityUpdate(u.update));
    if (!compact) return;
    pending.push(compact);
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
export async function postAgentMessage(
  channelId: string,
  owner: Identity,
  message: string,
  replyTo?: string,
  attachments: readonly AttachmentReference[] = [],
  extraTags: readonly string[][] = [],
): Promise<void> {
  const event: NostrEvent = signEvent(
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

  await publishEvent(event, owner);
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
  initialStatus: AgentPresenceStatus = 'online',
): AgentPresenceController {
  let stopped = false;
  let lastCreatedAt = 0;
  let chain = Promise.resolve();
  let status: AgentPresenceStatus = initialStatus;
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
        updates: batch.events,
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
