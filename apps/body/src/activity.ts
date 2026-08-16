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
  KIND_AGENT_DRAFT,
  KIND_AGENT_PRESENCE,
  TAG_AGENT_DRAFT,
  TAG_AGENT_PRESENCE,
  buildAttachmentTags,
  type AgentPresenceStatus,
  type AttachmentReference,
} from '@beeline/buzz-client';
import { sanitizeActivityUpdate } from './attachments.js';

export const ACTIVITY_TAG = 'agent-activity';
export const AGENT_MESSAGE_TAG = 'agent-message';
export const AGENT_TURN_TAG = 'agent-turn';
/** Coalescing window for live draft-text publishes — bounds relay write rate
 *  regardless of ACP chunk frequency (mirrors the activity batch's quota concern). */
export const AGENT_DRAFT_FLUSH_MS = 250;

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
  'reasoning',
  'reasoning_chunk',
  'thinking',
  'thinking_chunk',
  'analysis',
  'analysis_chunk',
  'plan',
  'user_message_chunk',
  'available_commands_update',
  'current_mode_update',
]);
/** Only these shell actions are useful as a standalone, user-facing milestone. */
const MAJOR_COMMAND =
  /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build|e2e|verify)\b|\b(?:vitest|jest|mocha|ava|playwright|tsc|eslint)\b|\bgit\s+commit\b|\b(?:gh|gh-axi)\s+pr\s+(?:create|open)\b|\b(?:open(?:ed)?|create(?:d)?)\s+(?:a\s+)?pull\s+request\b|\b(?:run|ran)\s+(?:the\s+)?(?:test|build|lint|typecheck|check|e2e|verification)\b)/i;
const MAX_SUMMARY_ACTIONS = 6;
const MAX_SUMMARY_LENGTH = 500;

interface ToolCallInfo {
  kind?: string;
  title?: string;
  command?: string;
  path?: string;
  isMcp: boolean;
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

function pathText(rawInput: unknown): string | undefined {
  const path = objectValue(rawInput)?.path;
  return typeof path === 'string' ? path : undefined;
}

/** MCP calls are implementation detail, never transcript activity. */
function isMcpToolCall(update: Record<string, unknown>): boolean {
  const title = typeof update.title === 'string' ? update.title : '';
  if (/^\s*mcp\.[^.\s]+\.[^.\s]+/i.test(title)) return true;
  const rawInput = objectValue(update.rawInput);
  return (
    (typeof rawInput?.server === 'string' && typeof rawInput?.tool === 'string') ||
    typeof rawInput?.mcpServer === 'string'
  );
}

function toolCallInfo(update: Record<string, unknown>): ToolCallInfo {
  return {
    kind: typeof update.kind === 'string' ? update.kind : undefined,
    title: typeof update.title === 'string' ? update.title : undefined,
    command: commandText(update.rawInput),
    path: pathText(update.rawInput),
    isMcp: isMcpToolCall(update),
  };
}

/** True once a tool call is load-bearing enough to show as its own transcript line. */
function isLoadBearingToolCall(info: ToolCallInfo): boolean {
  if (info.isMcp) return false;
  if (info.kind && LOAD_BEARING_TOOL_KINDS.has(info.kind)) return true;
  if (info.kind && LOW_SIGNAL_TOOL_KINDS.has(info.kind)) return false;
  // Shell work is noisy by default. Keep only explicit test/build/commit/PR
  // milestones; arbitrary commands and their output must never reach a Room.
  return MAJOR_COMMAND.test(info.command ?? info.title ?? '');
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
    path: info.path ?? existing?.path,
    isMcp: info.isMcp || existing?.isMcp || false,
  });
}

/**
 * True only for a *terminal* update the captain cares about: a completed
 * load-bearing tool call (an edit, a test run, a commit, a PR). A failure is
 * visible only when that call was itself a user-facing milestone. Pending/
 * in-progress tool chatter, MCP, reasoning, and planning never qualify.
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
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
  const known = toolCallId ? toolCallKinds.get(toolCallId) : undefined;
  const info = toolCallInfo(update);
  return isLoadBearingToolCall({
    kind: info.kind ?? known?.kind,
    title: info.title ?? known?.title,
    command: info.command ?? known?.command,
    path: info.path ?? known?.path,
    isMcp: info.isMcp || known?.isMcp || false,
  });
}

/** A deliberately non-raw label for a visible milestone. */
function describeMajorUpdate(
  update: Record<string, unknown>,
  toolCallKinds: Map<string, ToolCallInfo>,
): string {
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
  const known = toolCallId ? toolCallKinds.get(toolCallId) : undefined;
  const current = toolCallInfo(update);
  const info = {
    kind: current.kind ?? known?.kind,
    title: current.title ?? known?.title,
    command: current.command ?? known?.command,
    path: current.path ?? known?.path,
    isMcp: current.isMcp || known?.isMcp || false,
  };
  let label: string;
  if (info.kind === 'edit') label = info.path ? `Edited ${info.path}` : 'Edited a file';
  else if (info.kind === 'delete') label = info.path ? `Deleted ${info.path}` : 'Deleted a file';
  else if (info.kind === 'move') label = info.path ? `Moved ${info.path}` : 'Moved a file';
  else if (/\bgit\s+commit\b/i.test(info.command ?? info.title ?? '')) label = 'Committed changes';
  else if (/\b(?:gh|gh-axi)\s+pr\s+(?:create|open)\b|\bpull\s+request\b/i.test(info.command ?? info.title ?? ''))
    label = 'Opened a pull request';
  else if (/\b(?:build)\b/i.test(info.command ?? info.title ?? '')) label = 'Ran a build';
  else if (/\b(?:lint)\b/i.test(info.command ?? info.title ?? '')) label = 'Ran lint checks';
  else if (/\b(?:typecheck|tsc)\b/i.test(info.command ?? info.title ?? '')) label = 'Ran type checks';
  else label = 'Ran the test suite';
  return update.status === 'failed' ? `${label} failed` : label;
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
  const toolCallKinds = new Map<string, ToolCallInfo>();
  // Shallow-merged raw update per toolCallId: an ACP tool call typically
  // arrives as a `tool_call` creation event (kind/title/rawInput) followed by
  // a `tool_call_update`/`tool_result` terminal event (status/output) that
  // omits the earlier fields. Merging lets compactActivityUpdate see the
  // whole picture — files/diff/command from creation, output from the
  // terminal — from a single record.
  const toolCallRaw = new Map<string, Record<string, unknown>>();
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const events = pending;
    pending = [];
    if (!events.length) return;
    // Batch first, then keep only the major load-bearing actions — an edit, a
    // completed test/build/PR command, or a failure — so the projected
    // transcript reads like a clean assistant log, not raw tool telemetry.
    // Each surviving action still carries its full compact detail (files,
    // diffs, command, output) so the corner drill-down can inspect it.
    const major: Record<string, unknown>[] = [];
    const labels: string[] = [];
    for (const event of events) {
      if (!isMajorUpdate(event, toolCallKinds)) continue;
      const label = describeMajorUpdate(event, toolCallKinds);
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
      const merged = toolCallId ? (toolCallRaw.get(toolCallId) ?? event) : event;
      const detail = compactActivityUpdate(merged) ?? {};
      major.push({
        ...detail,
        sessionUpdate: 'tool_activity',
        title: label,
        status: event.status === 'failed' ? 'failed' : 'completed',
      });
      labels.push(label);
      if (toolCallId) {
        toolCallKinds.delete(toolCallId);
        toolCallRaw.delete(toolCallId);
      }
    }
    if (!major.length) return;
    const summary: Record<string, unknown> = {
      sessionUpdate: 'activity_summary',
      content: { type: 'text', text: summarizeMajorActions(labels) },
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
    const toolCallId = typeof sanitized.toolCallId === 'string' ? sanitized.toolCallId : undefined;
    if (toolCallId) toolCallRaw.set(toolCallId, { ...toolCallRaw.get(toolCallId), ...sanitized });
    pending.push(sanitized);
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

/**
 * Publish the live, growing text of an in-flight assistant reply. Parameterized
 * -replaceable (same convention as `#t=agent-presence`) so relay storage and
 * write volume stay bounded to one current record per channel no matter how
 * long the reply grows or how many deltas the ACP session emits.
 */
export async function postAgentDraft(
  channelId: string,
  owner: Identity,
  sessionId: string,
  requestId: string,
  text: string,
  createdAt = Math.floor(Date.now() / 1000),
): Promise<void> {
  const event: NostrEvent = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: createdAt,
      kind: KIND_AGENT_DRAFT,
      tags: [
        ['d', `${TAG_AGENT_DRAFT}:${channelId}`],
        ['h', channelId],
        ['t', TAG_AGENT_DRAFT],
        ['agent', owner.publicKey],
        ['session', sessionId],
        ['request', requestId],
      ],
      content: text,
    },
    owner.secretKey,
  );
  await publishEvent(event, owner);
}

export interface DraftStreamer {
  /** Feed the latest accumulated text as it grows. Safe to call at any rate. */
  onChunk(fullTextSoFar: string): void;
  /** Flush any buffered text once the turn settles (success, failure, or timeout). */
  finish(): Promise<void>;
}

/**
 * Coalesce `AcpClient.sessionPrompt`'s per-delta callback into a bounded-rate
 * replaceable publish, so a long or fast-streaming reply cannot flood the
 * per-pubkey relay quota the way a naive per-token write would.
 */
export function createDraftStreamer(
  channelId: string,
  owner: Identity,
  sessionId: string,
  requestId: string,
  flushMs = AGENT_DRAFT_FLUSH_MS,
): DraftStreamer {
  let latest = '';
  let published = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight = Promise.resolve();
  // A relay's NIP-33 tie-break is by `created_at` (then implementation-defined
  // for exact ties); streaming can easily flush several times inside one wall
  // -clock second, so bump strictly rather than reusing `Date.now()` — the
  // same fix `startAgentPresence` uses for its heartbeat.
  let lastCreatedAt = 0;
  const flush = () => {
    timer = undefined;
    if (latest === published) return;
    published = latest;
    const createdAt = Math.max(Math.floor(Date.now() / 1_000), lastCreatedAt + 1);
    lastCreatedAt = createdAt;
    inflight = inflight
      .then(() => postAgentDraft(channelId, owner, sessionId, requestId, published, createdAt))
      .catch((error) => console.error('[body] agent draft publish failed:', error));
  };
  return {
    onChunk(fullTextSoFar) {
      latest = fullTextSoFar;
      timer ??= setTimeout(flush, flushMs);
    },
    async finish() {
      if (timer) clearTimeout(timer);
      flush();
      await inflight;
    },
  };
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
