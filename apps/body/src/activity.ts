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
  agentDraftKey,
  agentPresenceKey,
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
export const CORNER_SESSION_TAG = 'corner-session';
/** Coalescing window for live draft-text publishes — bounds relay write rate
 *  regardless of ACP chunk frequency (mirrors the activity batch's quota concern). */
export const AGENT_DRAFT_FLUSH_MS = 250;

/** Resolve the NIP-10 root that a reply to this event must preserve. */
export function replyRootIdForEvent(event: NostrEvent): string {
  return (
    event.tags.find((tag) => tag[0] === 'e' && tag[1] && tag[3] === 'root')?.[1] ??
    event.tags.find((tag) => tag[0] === 'e' && tag[1] && tag[3] === 'reply')?.[1] ??
    event.id
  );
}

/**
 * ACP tool-call kinds that are always load-bearing: they change the worktree
 * (or a PR/branch derived from it) regardless of what command produced them.
 */
const LOAD_BEARING_TOOL_KINDS = new Set(['edit', 'delete', 'move']);
/** ACP tool-call kinds that are inherently background inspection, never surfaced alone. */
const LOW_SIGNAL_TOOL_KINDS = new Set(['read', 'search', 'think', 'fetch', 'other']);
/**
 * The subset of suppressed kinds that is specifically the agent *reasoning*.
 *
 * Its content never reaches the wire and must not: it is unbounded, it is the
 * noisiest thing the harness emits, and publishing it would blow the per-pubkey
 * quota on the one stretch of a turn that produces no user-facing result. What
 * is cheap, and what a reader actually wants, is the receipt — grok Build shows
 * a live `Thinking…` block for the whole stretch and then collapses it to a
 * five-word `Thought for 5.8s` the instant the answer lands. Only the elapsed
 * span is needed for that second half, and a span is a number.
 */
const REASONING_SESSION_UPDATE_KINDS = new Set([
  'agent_thought_chunk',
  'agent_thought',
  'reasoning',
  'reasoning_chunk',
  'thinking',
  'thinking_chunk',
  'analysis',
  'analysis_chunk',
]);
/** Below this a receipt is clutter, not information. */
const REASONING_RECEIPT_MIN_MS = 400;

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

/** True for an update that is the agent thinking, not the agent working. */
function isReasoningUpdate(update: Record<string, unknown>): boolean {
  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
  return Boolean(sessionUpdate && REASONING_SESSION_UPDATE_KINDS.has(sessionUpdate));
}

/**
 * The verb an observational (never-projected) tool call is counted under in the
 * turn's rollup tally.
 *
 * The drop itself is deliberate and stays — reads, searches, and MCP chatter
 * must not each become their own relay write, or a research-heavy turn blows
 * the per-pubkey quota. What was missing is that the *count* was dropped too,
 * so a client could not say "41 files read, 12 searches" at all and a long
 * research phase rendered as total silence. Tallying costs nothing on the wire:
 * the tally rides the `activity_summary` event that is already published.
 */
function observationalVerb(
  update: Record<string, unknown>,
  toolCallKinds: Map<string, ToolCallInfo>,
): string | undefined {
  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
  if (!sessionUpdate || SUPPRESSED_SESSION_UPDATE_KINDS.has(sessionUpdate)) return undefined;
  if (
    sessionUpdate !== 'tool_call' &&
    sessionUpdate !== 'tool_call_update' &&
    sessionUpdate !== 'tool_result'
  ) {
    return undefined;
  }
  // Count each call once, on the terminal event, so a creation event and its
  // own `tool_call_update` do not tally the same call twice.
  const status =
    typeof update.status === 'string'
      ? update.status
      : sessionUpdate === 'tool_result'
        ? 'completed'
        : undefined;
  if (status !== 'completed' && status !== 'failed') return undefined;
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
  const known = toolCallId ? toolCallKinds.get(toolCallId) : undefined;
  const current = toolCallInfo(update);
  const kind = current.kind ?? known?.kind;
  if (current.isMcp || known?.isMcp) return 'queried';
  switch (kind) {
    case 'read':
      return 'read';
    case 'search':
      return 'searched';
    case 'fetch':
      return 'fetched';
    case 'think':
      return 'reasoned';
    default:
      return 'ran';
  }
}

/** Compact per-call receipt for a folded (never separately projected)
 *  observational call: what it looked at, and a short taste of what it found. */
export interface CompactObservedCall {
  verb: string;
  target?: string;
  result?: string;
}

/** A folded batch can carry many calls; cap the receipts, not the tally. */
const MAX_OBSERVED_DETAILS_PER_BATCH = 20;
const MAX_OBSERVED_TARGET_CHARS = 160;
const MAX_OBSERVED_RESULT_CHARS = 160;

/** What the call looked at — a path, a search/fetch query, or a bare command —
 *  falling back to its title so a call the client can't otherwise name still
 *  shows something. */
function observedTarget(
  update: Record<string, unknown>,
  known: ToolCallInfo | undefined,
): string | undefined {
  const current = toolCallInfo(update);
  const path = current.path ?? known?.path;
  if (path) return compactText(path, MAX_OBSERVED_TARGET_CHARS);
  const rawInput = objectValue(update.rawInput);
  // A terminal update (tool_call_update/tool_result) usually omits rawInput —
  // only the creation event carried it — so fall back to what trackToolCall
  // remembered from that creation event before falling back to a bare title.
  const candidate =
    rawInput?.pattern ?? rawInput?.query ?? rawInput?.url ?? current.command ?? known?.command;
  if (typeof candidate === 'string' && candidate.trim()) {
    return compactText(candidate, MAX_OBSERVED_TARGET_CHARS);
  }
  const title = current.title ?? known?.title;
  return title ? compactText(title, MAX_OBSERVED_TARGET_CHARS) : undefined;
}

/** A line or two of what the call returned — never the raw multi-KB output a
 *  read/search call can carry, just enough to say what it found. */
function observedResult(update: Record<string, unknown>): string | undefined {
  const toolCall = objectValue(update.toolCall);
  const raw =
    update.output ?? update.rawOutput ?? update.result ?? update.content ?? toolCall?.output;
  const text = compactText(raw, MAX_OBSERVED_RESULT_CHARS);
  if (!text) return undefined;
  const firstLines = text.split(/\r?\n/).slice(0, 2).join(' ').trim();
  return firstLines ? compactText(firstLines, MAX_OBSERVED_RESULT_CHARS) : undefined;
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
  else if (
    /\b(?:gh|gh-axi)\s+pr\s+(?:create|open)\b|\bpull\s+request\b/i.test(
      info.command ?? info.title ?? '',
    )
  )
    label = 'Opened a pull request';
  else if (/\b(?:build)\b/i.test(info.command ?? info.title ?? '')) label = 'Ran a build';
  else if (/\b(?:lint)\b/i.test(info.command ?? info.title ?? '')) label = 'Ran lint checks';
  else if (/\b(?:typecheck|tsc)\b/i.test(info.command ?? info.title ?? ''))
    label = 'Ran type checks';
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
function stripCodexHarnessPreamble(message: string): string {
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

// pi-acp's `session/new` handler emits its whole startup block as a single
// leading `agent_message_chunk` (see pi-acp's buildStartupInfo/buildUpdateNotice):
//   pi v0.83.0
//   ---
//
//   ## Skills
//   - /home/user/.agents/skills/foo/SKILL.md
//   ...
//
//   ---
//   New version available: v0.84.2 (installed v0.83.0). Run: `npm i -g @earendil-works/pi-coding-agent`
// Quiet-mode installs skip straight to just the update-notice line. The live
// draft and final reply share this sanitizer so no harness startup block can
// become either provisional or final conversation text.
const PI_STARTUP_VERSION_LINE = /^pi v\d+(?:\.\d+)+(?:[-+][\w.]+)?\s*$/i;
const PI_UPDATE_NOTICE_LINE =
  /^new version available:\s*v?\d+(?:\.\d+)+(?:[-+][\w.]+)?\s*\(installed\s*v?\d+(?:\.\d+)+(?:[-+][\w.]+)?\)\.\s*run:\s*`?npm i(?:nstall)? -g\s+\S+`?\.?\s*$/i;
const PI_KNOWN_SECTION_HEADER = /^##\s+(?:Context|Skills|Prompts|Extensions)\s*$/i;
const PI_DIVIDER_LINE = /^-{3,}\s*$/;
/** A bullet whose entire body is a bare path/command token (no spaces) — how
 *  pi lists skill/context/extension files, never how narration writes prose. */
const PI_PATH_BULLET_LINE = /^[-*]\s+(?:\/|~\/|npm:)\S*$/;

function nextSignificantLineMatches(
  lines: readonly string[],
  from: number,
  pattern: RegExp,
): boolean {
  let j = from;
  while (j < lines.length && !lines[j]!.trim()) j++;
  return j < lines.length && pattern.test(lines[j]!.trim());
}

/** Remove a leading run of pi-acp's harness startup chatter (version banner,
 *  skill/context/extension path dumps), never mid-reply text. */
function stripPiHarnessPreamble(message: string): string {
  const lines = message.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i >= lines.length) return message;

  const first = lines[i]!.trim();
  const entersKnownBlock =
    PI_STARTUP_VERSION_LINE.test(first) ||
    PI_KNOWN_SECTION_HEADER.test(first) ||
    PI_UPDATE_NOTICE_LINE.test(first) ||
    (PI_DIVIDER_LINE.test(first) &&
      nextSignificantLineMatches(lines, i + 1, PI_UPDATE_NOTICE_LINE));
  if (!entersKnownBlock) return message;

  let sectionOpen = PI_KNOWN_SECTION_HEADER.test(first);
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }
    if (
      PI_STARTUP_VERSION_LINE.test(line) ||
      PI_DIVIDER_LINE.test(line) ||
      PI_UPDATE_NOTICE_LINE.test(line)
    ) {
      i++;
      continue;
    }
    if (PI_KNOWN_SECTION_HEADER.test(line)) {
      sectionOpen = true;
      i++;
      continue;
    }
    if (sectionOpen && PI_PATH_BULLET_LINE.test(line)) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n');
}

/** Remove known harness/CLI startup boilerplate from the front of an agent
 *  draft or final reply — never mid-reply text. Each harness's shape is
 *  matched independently; composing them is safe since a message only ever
 *  carries one harness's boilerplate. */
export function stripAgentReplyPreamble(message: string): string {
  return stripPiHarnessPreamble(stripCodexHarnessPreamble(message));
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

/**
 * A corner plan cannot depend on a harness choosing to emit ACP `plan`
 * updates. Body can seed the projection with the task-authored plan from the
 * hidden corner-metadata turn. When neither source provides steps, the
 * projection reports only that work is underway instead of inventing a plan.
 */
export type ActivityProjectionController = (() => void) & {
  startPlan(objective: string, authoredPlan?: CompactActivityPlan): Promise<void>;
  completePlan(): Promise<void>;
  currentPlan(): CompactActivityPlan | undefined;
};

const MAX_ACTIVITY_DETAIL_CHARS = 12_000;
const MAX_ACTIVITY_INPUT_CHARS = 4_000;
const MAX_ACTIVITY_PLAN_OBJECTIVE_CHARS = 160;
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

/**
 * The plan/checklist carried by an update, in whichever shape the harness
 * used. Three are known and all three appear in the wild: ACP's own `plan`
 * `session/update` (`entries: [{content, status}]`), a harness that models
 * the same thing as an `update_plan` tool call (`rawInput.plan: [...]`), and
 * an already-compacted `{objective, items}` record.
 *
 * Every field that survives is a short structured string capped by
 * `compactText`. That bound is deliberate: this is the only agent-authored
 * text that reaches the corner's pinned objective panel, and a panel that
 * renders free-running harness output is exactly how the first objective
 * banner (PR #165) ended up showing a codex startup dump at the top of every
 * corner. Structured, length-capped fields cannot carry a banner.
 */
function activityPlan(...sources: unknown[]): CompactActivityPlan | undefined {
  for (const source of sources) {
    const record = objectValue(source);
    if (!record) continue;
    const planValue = record.plan;
    const planRecord = objectValue(planValue);
    const rawItems = Array.isArray(planValue)
      ? planValue
      : Array.isArray(planRecord?.items)
        ? (planRecord!.items as unknown[])
        : Array.isArray(planRecord?.entries)
          ? (planRecord!.entries as unknown[])
          : Array.isArray(record.items)
            ? record.items
            : Array.isArray(record.entries)
              ? record.entries
              : [];
    const items = rawItems
      .map((item) => {
        const entry = objectValue(item);
        // `content` is ACP's own field name for a plan entry's text. It is
        // taken only when it is a plain string — on a tool call the same key
        // holds an array of content blocks, which is not a plan step.
        const stepSource =
          entry?.step ??
          entry?.text ??
          entry?.title ??
          (typeof entry?.content === 'string' ? entry.content : undefined);
        const step = compactText(stepSource, 240);
        return step ? { step, status: planStatus(entry?.status) } : undefined;
      })
      .filter((item): item is CompactActivityPlanItem => Boolean(item));
    const objective = compactText(record.objective ?? planRecord?.objective, 320);
    if (items.length || objective) return { ...(objective ? { objective } : {}), items };
  }
  return undefined;
}

export function latestActivityPlanFromEvents(
  events: readonly Pick<NostrEvent, 'content' | 'created_at' | 'id'>[],
): CompactActivityPlan | undefined {
  let latest: CompactActivityPlan | undefined;
  for (const event of [...events].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  )) {
    try {
      const batch = JSON.parse(event.content) as {
        update?: { updates?: unknown[] };
        events?: unknown[];
      };
      for (const update of batch.update?.updates ?? batch.events ?? [])
        latest = activityPlan(update) ?? latest;
    } catch {
      /* non-activity prose shares the query */
    }
  }
  return latest;
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
): ActivityProjectionController {
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
  // The open reasoning stretch, spanning batches. It closes when real work
  // lands — which is exactly the flush that has something to publish — so a
  // long think that straddles several 5s windows still reports one span, not
  // one per window, and a turn that is still only thinking reports nothing at
  // all rather than a partial count that would have to be revised.
  let reasoningOpenedAt: number | undefined;
  let reasoningLastAt: number | undefined;
  // The agent's current plan/checklist, and the last one actually put on the
  // wire. A task-authored opening plan seeds the panel; later ACP `plan`
  // updates are suppressed from the transcript (they are reasoning there,
  // not work) but replace that seed through the `activity_summary` event this
  // projection already publishes — the same zero-extra-write technique
  // `thoughtMs` uses. Only a *changed* plan rides along, so a 10-step
  // checklist is not re-sent on every 5s batch.
  let currentPlan: CompactActivityPlan | undefined;
  // The objective names the corner, not its current turn. Seed it once from
  // daemon-owned opening metadata; follow-ups and harness plans cannot edit it.
  let pinnedObjective: string | undefined;
  let publishedPlanKey = '';
  let publishTail: Promise<void> = Promise.resolve();
  const publishBatch = (events: Record<string, unknown>[]): Promise<void> => {
    const publish = () =>
      emitActivityEvent(channelId, channelOwner, { sessionId, channelId, events });
    // Keep plan snapshots and telemetry batches in the order Body produced
    // them even when the relay is slow. A rejected publish must not poison all
    // later progress updates.
    publishTail = publishTail.then(publish, publish);
    return publishTail;
  };
  const publishPlan = (plan: CompactActivityPlan): Promise<void> => {
    publishedPlanKey = JSON.stringify(plan);
    return publishBatch([
      {
        sessionUpdate: 'activity_summary',
        content: { type: 'text', text: '' },
        plan,
      },
    ]);
  };
  const safePlanObjective = (objective: string): string | undefined => {
    const plain = objective
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\[([^\]]+)\]\([^\s)]+\)/g, '$1')
      .replace(/[`*_#>|]/g, ' ')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!plain) return undefined;
    if (plain.length <= MAX_ACTIVITY_PLAN_OBJECTIVE_CHARS) return plain;
    return `${plain.slice(0, MAX_ACTIVITY_PLAN_OBJECTIVE_CHARS - 1).trimEnd()}…`;
  };
  const fallbackPlan = (objective: string): CompactActivityPlan => {
    const distilled = safePlanObjective(objective);
    return {
      ...(distilled ? { objective: distilled } : {}),
      items: [{ step: 'Working…', status: 'in_progress' }],
    };
  };
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
    // Tally what the filter drops. Read-only work never earns its own wire
    // event, but its shape ("read 41, searched 12") is exactly what makes a
    // research phase legible instead of silent, so the counts ride along on
    // the summary event that is published anyway.
    //
    // This has to happen in the *same* pass: the major branch below clears the
    // tool call's tracked kind/command, so a second pass would re-classify the
    // very milestone it just published as an anonymous observational call.
    const rollup: Record<string, number> = {};
    // A compact receipt per folded call — not the calls themselves, which stay
    // dropped for the quota reason above, but enough (what it looked at, a line
    // or two of what it found) that the review sheet has something real to show
    // instead of just the tally. Capped independently of the tally: a batch of
    // hundreds of reads still reports its true count, just not hundreds of rows.
    const observed: CompactObservedCall[] = [];
    for (const event of events) {
      if (!isMajorUpdate(event, toolCallKinds)) {
        const verb = observationalVerb(event, toolCallKinds);
        if (verb) {
          rollup[verb] = (rollup[verb] ?? 0) + 1;
          // MCP calls stay implementation detail even in the drill-down —
          // 'queried' is the one verb observationalVerb reserves for them.
          if (verb !== 'queried' && observed.length < MAX_OBSERVED_DETAILS_PER_BATCH) {
            const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
            const known = toolCallId ? toolCallKinds.get(toolCallId) : undefined;
            const target = observedTarget(event, known);
            const result = observedResult(event);
            observed.push({ verb, ...(target ? { target } : {}), ...(result ? { result } : {}) });
          }
        }
        continue;
      }
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
    const rollupTotal = Object.values(rollup).reduce((sum, count) => sum + count, 0);
    // A plan change alone earns a flush. Without this a turn that opens by
    // planning and then only reads files would leave the objective panel
    // empty for the whole first batch — and a turn that does nothing but
    // re-plan would never publish the checklist at all.
    const planKey = currentPlan ? JSON.stringify(currentPlan) : '';
    const plan = planKey && planKey !== publishedPlanKey ? currentPlan : undefined;
    // A reads-only batch used to emit nothing at all, which is the dead-air
    // bug: during the exact stretch the agent is working hardest the corner
    // showed no sign of life. It now emits exactly one event (the summary),
    // never more than the mixed case already cost.
    if (!major.length && !rollupTotal && !plan) return;
    // Work landed, so the reasoning that preceded it is over: close the span
    // and let the receipt ride this same event. Reset unconditionally, even
    // below the reporting floor, or a sub-threshold think would leak into the
    // next stretch's total.
    // First reasoning chunk to last, not first-chunk-to-now: the flush that
    // carries the receipt can be up to a whole batch window later, and the
    // tool calls in between are not thinking. Under-reporting a stalled think
    // is the safe direction — the receipt is a fact about the agent, and the
    // live rail already reports that something is still happening.
    const thoughtMs =
      reasoningOpenedAt !== undefined && reasoningLastAt !== undefined
        ? reasoningLastAt - reasoningOpenedAt
        : 0;
    reasoningOpenedAt = undefined;
    reasoningLastAt = undefined;
    const summary: Record<string, unknown> = {
      sessionUpdate: 'activity_summary',
      content: { type: 'text', text: summarizeMajorActions(labels) },
      ...(rollupTotal ? { rollup } : {}),
      ...(observed.length ? { observed } : {}),
      ...(thoughtMs >= REASONING_RECEIPT_MIN_MS ? { thoughtMs } : {}),
      ...(plan ? { plan } : {}),
    };
    if (plan) publishedPlanKey = planKey;
    void publishBatch([...major, summary]);
  };
  const onUpdate = (u: SessionUpdate) => {
    if (u.sessionId !== sessionId) return;
    // Assistant prose is published once, as a first-class channel message,
    // after sessionPrompt completes. Keep the activity stream for thought/tool
    // telemetry so conversation copy cannot be duplicated or lost in a batch.
    if (u.update.sessionUpdate === 'agent_message_chunk') return;
    const sanitized = sanitizeActivityUpdate(u.update);
    if (isReasoningUpdate(sanitized)) {
      const now = Date.now();
      reasoningOpenedAt ??= now;
      reasoningLastAt = now;
    }
    // Read the plan off every update, including the ones dropped below: ACP
    // sends it as its own suppressed `plan` update, while other harnesses
    // model it as an `update_plan` tool call that is not load-bearing enough
    // to survive `isMajorUpdate`. Both are the same fact about the turn.
    const updatePlan = activityPlan(sanitized, sanitized.rawInput, objectValue(sanitized.toolCall));
    if (updatePlan?.items.length) {
      currentPlan = {
        ...(pinnedObjective ? { objective: pinnedObjective } : {}),
        items: updatePlan.items,
      };
    }
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
  const controller = (() => {
    client.off('session/update', onUpdate);
    flush();
  }) as ActivityProjectionController;
  controller.startPlan = async (objective: string, authoredPlan?: CompactActivityPlan) => {
    const compactAuthoredPlan = authoredPlan ? activityPlan(authoredPlan) : undefined;
    const distilled = safePlanObjective(objective);
    pinnedObjective ??= distilled ?? compactAuthoredPlan?.objective;
    currentPlan = compactAuthoredPlan?.items.length
      ? {
          ...(pinnedObjective
            ? { objective: pinnedObjective }
            : compactAuthoredPlan.objective
              ? { objective: compactAuthoredPlan.objective }
              : {}),
          items: compactAuthoredPlan.items,
        }
      : fallbackPlan(pinnedObjective ?? objective);
    await publishPlan(currentPlan);
  };
  controller.completePlan = async () => {
    flush();
    if (!currentPlan?.items.length) return;
    const completed: CompactActivityPlan = {
      ...currentPlan,
      items: currentPlan.items.map((item) => ({ ...item, status: 'completed' })),
    };
    const key = JSON.stringify(completed);
    currentPlan = completed;
    if (key === publishedPlanKey) {
      await publishTail;
      return;
    }
    await publishPlan(completed);
  };
  controller.currentPlan = () =>
    currentPlan
      ? { ...currentPlan, items: currentPlan.items.map((item) => ({ ...item })) }
      : undefined;
  return controller;
}

/** Publish a completed assistant turn as durable conversation, not telemetry. */
export function buildAgentMessage(
  channelId: string,
  owner: Identity,
  message: string,
  replyTo?: string,
  attachments: readonly AttachmentReference[] = [],
  extraTags: readonly string[][] = [],
  replyRootId?: string,
  createdAt = Math.floor(Date.now() / 1000),
): NostrEvent {
  return signEvent(
    {
      pubkey: owner.publicKey,
      created_at: createdAt,
      kind: 9,
      tags: [
        ['h', channelId],
        ['t', AGENT_MESSAGE_TAG],
        ...(replyTo && replyRootId && replyRootId !== replyTo
          ? [['e', replyRootId, '', 'root']]
          : []),
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
  replyRootId?: string,
  createdAt?: number,
): Promise<void> {
  await publishEvent(
    buildAgentMessage(
      channelId,
      owner,
      message,
      replyTo,
      attachments,
      extraTags,
      replyRootId,
      createdAt,
    ),
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
        ['d', agentDraftKey(channelId)],
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

/**
 * Replace a channel's last live draft with a terminal marker. During ordinary
 * turn finalization `cornerId` and `scopeChannelId` are the same channel. The
 * separate scope remains available for corner cleanup: a parent Room stays
 * writable even when the corner was deleted out of band, while the unchanged
 * `d` key still replaces the stale corner record.
 */
export async function retractAgentDraft(
  cornerId: string,
  scopeChannelId: string,
  owner: Identity,
  createdAt = Math.floor(Date.now() / 1_000),
): Promise<void> {
  await publishEvent(
    signEvent(
      {
        pubkey: owner.publicKey,
        created_at: createdAt,
        kind: KIND_AGENT_DRAFT,
        tags: [
          ['d', agentDraftKey(cornerId)],
          ['h', scopeChannelId],
          ['t', TAG_AGENT_DRAFT],
          ['agent', owner.publicKey],
          ['status', 'closed'],
          ['corner', cornerId],
        ],
        content: '',
      },
      owner.secretKey,
    ),
    owner,
  );
}

/**
 * `created_at` (unix seconds) strictly greater than the last value `lastRef`
 * produced, floored at the current wall clock. Several call sites in this
 * file can publish more than once within the same wall-clock second
 * (streaming draft snapshots, a presence heartbeat plus its offline marker)
 * — a relay's same-second NIP-33 tie-break isn't
 * guaranteed to pick the newest event, so `Date.now()` alone isn't enough.
 */
function nextMonotonicSecond(lastRef: { value: number }): number {
  const createdAt = Math.max(Math.floor(Date.now() / 1_000), lastRef.value + 1);
  lastRef.value = createdAt;
  return createdAt;
}

export interface DraftStreamer {
  /** Feed the latest accumulated text as it grows. Safe to call at any rate. */
  onChunk(fullTextSoFar: string): void;
  /** Flush buffered text, then replace the live draft with a terminal marker. */
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
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight = Promise.resolve();
  const lastCreatedAt = { value: 0 };
  const publishedSnapshots = new Set<string>();
  const flush = () => {
    timer = undefined;
    // A cold session's harness startup banner (pi/Codex boilerplate) is the
    // first thing to stream in on a fresh ACP session — strip it the same
    // way the reconciled final message is stripped, so a turn interrupted
    // right after startup output never leaves the raw banner as the last
    // thing published to the Room. While only boilerplate has streamed in,
    // the stripped text is empty and nothing is published at all.
    const stripped = stripAgentReplyPreamble(latest).trim();
    if (stripped === published || publishedSnapshots.has(stripped)) return;
    published = stripped;
    if (!stripped) return;
    publishedSnapshots.add(stripped);
    // Capture the snapshot before queueing the publish. Reading the mutable
    // `published` variable inside this closure lets a later flush replace it
    // before a slow earlier relay write starts, sending the newer snapshot
    // twice and never sending the earlier one.
    const snapshot = stripped;
    const createdAt = nextMonotonicSecond(lastCreatedAt);
    inflight = inflight
      .then(() => postAgentDraft(channelId, owner, sessionId, requestId, snapshot, createdAt))
      .catch((error) => console.error('[body] agent draft publish failed:', error));
  };
  return {
    onChunk(fullTextSoFar) {
      if (finished) return;
      latest = fullTextSoFar;
      timer ??= setTimeout(flush, flushMs);
    },
    async finish() {
      if (finished) {
        await inflight;
        return;
      }
      finished = true;
      if (timer) clearTimeout(timer);
      flush();
      if (publishedSnapshots.size > 0) {
        const createdAt = nextMonotonicSecond(lastCreatedAt);
        inflight = inflight
          .then(() => retractAgentDraft(channelId, channelId, owner, createdAt))
          .catch((error) => console.error('[body] agent draft retract failed:', error));
      }
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

export function postCornerSessionStatus(
  channelId: string,
  owner: Identity,
  sessionId: string,
  status: 'live' | 'suspended' | 'waiting-for-slot',
  sequence: number,
): Promise<void> {
  return postControlMessage(channelId, owner, `Corner session ${status}.`, [
    ['t', CORNER_SESSION_TAG],
    ['session', sessionId],
    ['agent', owner.publicKey],
    ['status', status],
    ['sequence', String(sequence)],
  ]);
}

/**
 * One-time, honest "still working" notice for a turn that has gone quiet for
 * longer than a short idle window, published as an ordinary visible message
 * (same wire shape as any other agent reply) so it renders in the transcript
 * without any client-side changes. This never itself cancels or retries the
 * turn — it only tells the user their agent isn't dead, well before the full
 * idle-cancel timeout would otherwise leave them looking at silence.
 *
 * `replyTo`, when given, MUST name an event in `channelId` itself — a relay
 * rejects a kind:9 reply whose referenced parent lives in a different
 * channel ("parent event belongs to a different channel"). A corner's first
 * turn is triggered by a Room event, not a corner one, so callers with no
 * same-channel parent to thread to must omit it rather than passing a
 * cross-channel id.
 *
 * `replyRootId` is the original NIP-10 thread root. Nested replies must carry
 * it exactly like a completed agent reply does or the relay rejects the event
 * because its root does not match the referenced parent's ancestry.
 */
export function postAgentStallNotice(
  channelId: string,
  owner: Identity,
  replyTo?: string,
  replyRootId?: string,
): Promise<void> {
  return postAgentMessage(
    channelId,
    owner,
    'Still working on this — my coding backend is taking longer than usual to respond.',
    replyTo,
    [],
    [],
    replyRootId,
  );
}

/** Marker tag on the quiet "your steer is queued" acknowledgement below. */
export const STEER_QUEUED_TAG = 'steer-queued';

/** Marker tag on the "that slash command is not a Beeline command" notice. */
export const SLASH_COMMAND_NOTICE_TAG = 'slash-command-notice';

/**
 * Immediate, lightweight acknowledgement that a message which arrived while a
 * turn was already running has been RECEIVED and will be delivered as the next
 * prompt — never a fabricated agent answer, and deliberately distinct from
 * `postAgentStallNotice` above ("still working" is a statement about the
 * backend's silence; this one is a statement about the human's own input).
 *
 * Published as a `body-control` status event rather than an `#t=agent-message`
 * so it renders as a quiet system line and never joins the agent's attributed
 * voice run in the transcript. Callers are responsible for keeping it quiet —
 * at most one per channel per active turn (see `Body.acknowledgeQueuedSteer`).
 */
export function postSteerQueuedNotice(
  channelId: string,
  owner: Identity,
  requestId?: string,
): Promise<void> {
  return postControlMessage(
    channelId,
    owner,
    'Got it — queued. I’ll pick this up as soon as the current step finishes.',
    [['t', STEER_QUEUED_TAG], ['status', 'queued'], ...(requestId ? [['request', requestId]] : [])],
  );
}

/**
 * Visible marker that a message began with a slash command Beeline does not
 * run. Published as a `body-control` status event (like the queued-steer ack
 * above) so it renders as a system line and never joins the agent's voice:
 * it is a statement about the human's input, not agent speech.
 *
 * The marked message is still delivered to the agent as an ordinary request —
 * this notice exists so nobody can mistake a harness's own `/verb` vocabulary
 * for one of Beeline's composer commands, not to block the text.
 */
export function postSlashCommandNotice(
  channelId: string,
  owner: Identity,
  message: string,
  command: string,
): Promise<void> {
  return postControlMessage(channelId, owner, message, [
    ['t', SLASH_COMMAND_NOTICE_TAG],
    ['command', command],
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
        ['d', agentPresenceKey(channelId)],
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

/** Same terminal replacement as {@link retractAgentDraft}, for presence. */
export async function retractAgentPresence(
  cornerId: string,
  scopeChannelId: string,
  owner: Identity,
  createdAt = Math.floor(Date.now() / 1_000),
): Promise<void> {
  await publishEvent(
    signEvent(
      {
        pubkey: owner.publicKey,
        created_at: createdAt,
        kind: KIND_AGENT_PRESENCE,
        tags: [
          ['d', agentPresenceKey(cornerId)],
          ['h', scopeChannelId],
          ['t', TAG_AGENT_PRESENCE],
          ['agent', owner.publicKey],
          ['status', 'offline'],
          ['terminal', 'closed'],
          ['corner', cornerId],
        ],
        content: 'offline',
      },
      owner.secretKey,
    ),
    owner,
  );
}

/**
 * A relay quota rejection advertises its own delay in the refusal text
 * ("retry in 12s"). Parsed here so presence and Room polling honour the same
 * instruction rather than each guessing.
 */
export function relayRetryAfterMs(error: unknown): number {
  const seconds = [...String(error).matchAll(/retry in\s+(\d+(?:\.\d+)?)s/gi)].map((match) =>
    Number(match[1]),
  );
  return seconds.length ? Math.ceil(Math.max(...seconds) * 1_000) : 0;
}

/** Longest a relay's own advertised quota delay is honoured for one heartbeat. */
const AGENT_PRESENCE_RETRY_BASE_MS = 1_000;
const AGENT_PRESENCE_RETRY_CAP_MS = 8_000;
export const AGENT_PRESENCE_RETRY_MAX_ATTEMPTS = 4;

/**
 * Spacing for one retried heartbeat.
 *
 * `publishEvent` (`packages/buzz-client/src/http.ts`) retries 5xx and network
 * failures only, so a relay quota rejection (HTTP 429) comes straight back out
 * — and a dropped heartbeat is not a lost log line, it is lease time: at a 45s
 * cadence against a 120s lease, two swallowed heartbeats are enough to make a
 * perfectly live daemon read as offline in every client until the quota window
 * clears. Retrying inside the interval keeps the lease alive instead.
 *
 * Jitter is not decoration: one daemon holds a heartbeat per Room, they were
 * all rejected by the same burst, and retrying them in lockstep is how a quota
 * rejection becomes a self-sustaining one.
 */
export function agentPresenceRetryDelayMs(
  attempt: number,
  error?: unknown,
  random: () => number = Math.random,
): number {
  const exponentialMs = Math.min(
    AGENT_PRESENCE_RETRY_CAP_MS,
    AGENT_PRESENCE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  // An explicit quota instruction always wins over our own steady-state cap:
  // retrying earlier than the relay asked recreates the storm.
  const base = Math.max(exponentialMs, relayRetryAfterMs(error));
  const jittered = base * (0.75 + random() * 0.5);
  // Past one heartbeat interval the timer's own next tick is the better
  // retry — with coalescing below it carries the freshest status anyway.
  return Math.min(AGENT_PRESENCE_HEARTBEAT_MS, Math.round(jittered));
}

/**
 * Start a low-rate heartbeat. Publishes `online` immediately (prompt re-presence
 * on daemon startup) and serializes refreshes so a slow relay cannot create
 * overlapping requests. The returned stop function goes QUIET: it drains any
 * in-flight heartbeat and stops refreshing, but publishes nothing.
 *
 * The reader's online/offline verdict is nothing but "how old is the newest
 * presence record" — an explicit offline marker on graceful shutdown would
 * make every planned restart (self-update handover, `beeline start` restart)
 * flash the agent OFFLINE in every client until the replacement daemon's first
 * heartbeat lands. Going quiet instead means a restart inside the lease window
 * (`AGENT_PRESENCE_STALE_MS`) is a non-event: the last `online` record stays
 * valid until the new daemon replaces it. A genuinely dead daemon — crash,
 * kill -9, deliberate stop — is still detected within that same bounded lease:
 * silence expires honestly. `setStatus('offline')` remains for the one shape
 * where going quiet would LIE: this daemon is up but its relay connection is
 * not, and the outage has outlived the lease.
 *
 * Two further properties are load-bearing for the client verdict:
 *
 *  - **`created_at` is stamped at PUBLISH time, never at enqueue time.** A
 *    heartbeat that waited behind a retrying predecessor would otherwise land
 *    carrying a timestamp from minutes ago, and — because this is a
 *    parameterized-replaceable record — that already-expired stamp becomes the
 *    newest one the relay holds. The reader then sees a freshly delivered
 *    heartbeat that is instantly past its lease and keeps showing the agent
 *    offline even though presence has recovered.
 *  - **Heartbeats coalesce rather than queue.** Only the latest presence record
 *    matters, so a tick that fires while another attempt is still retrying
 *    replaces it. Queued heartbeats are pure waste against the very quota that
 *    was already rejecting them.
 */
export function startAgentPresence(
  channelId: string,
  owner: Identity,
  intervalMs = AGENT_PRESENCE_HEARTBEAT_MS,
  onPublished?: (status: AgentPresenceStatus) => void,
  initialStatus: AgentPresenceStatus = 'online',
): AgentPresenceController {
  let stopped = false;
  const lastCreatedAt = { value: 0 };
  let chain = Promise.resolve();
  let status: AgentPresenceStatus = initialStatus;
  const generationId = randomUUID();

  /** Sleep in slices so `stop()` is never held for a whole backoff delay. */
  const backoff = async (delayMs: number): Promise<void> => {
    for (let remaining = delayMs; remaining > 0 && !stopped; remaining -= 250) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
  };

  const publishWithRetry = async (nextStatus: AgentPresenceStatus): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await postAgentPresence(
          channelId,
          owner,
          nextStatus,
          nextMonotonicSecond(lastCreatedAt),
          generationId,
        );
        onPublished?.(nextStatus);
        return;
      } catch (error) {
        const lastAttempt = attempt >= AGENT_PRESENCE_RETRY_MAX_ATTEMPTS;
        // An outage's own offline marker still retries: it is what tells every
        // reader the daemon's relay path is down rather than merely unreachable.
        if (lastAttempt || stopped) {
          console.error(
            `[body] agent presence ${nextStatus} failed after ${attempt} attempts:`,
            error,
          );
          return;
        }
        await backoff(agentPresenceRetryDelayMs(attempt, error));
        if (stopped && nextStatus !== 'offline') return;
      }
    }
  };

  const queue: AgentPresenceStatus[] = [];
  let inflightStatus: AgentPresenceStatus | null = null;
  let draining = false;
  const enqueue = (nextStatus: AgentPresenceStatus) => {
    // Coalesce only a REDUNDANT repeat, never a transition. While something is
    // in flight, an ordinary heartbeat tick restating the status already being
    // published adds nothing to a replaceable record and just spends more of
    // the quota that is currently rejecting it; an online→offline change is
    // real news and always gets its own publish. When nothing is in flight the
    // repeat is the whole point — that is what refreshes the lease.
    if (draining && nextStatus === (queue.at(-1) ?? inflightStatus)) return chain;
    queue.push(nextStatus);
    if (draining) return chain;
    draining = true;
    chain = chain
      .then(async () => {
        for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
          inflightStatus = target;
          await publishWithRetry(target);
        }
      })
      .finally(() => {
        draining = false;
        inflightStatus = null;
      });
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

  // Deliberately NO offline publish here — see the docblock above. A planned
  // shutdown is a quiet handover; the lease is the death signal.
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await chain;
  };
  return Object.assign(stop, { generationId, setStatus });
}

/**
 * Publish daemon-owned work into the same durable activity stream as ACP tool
 * updates. Landing is host work, not a synthetic agent turn, but it still
 * belongs in the transcript's live machine ledger rather than in a second
 * progress-card vocabulary.
 */
export async function postAgentActivityBatch(
  channelId: string,
  owner: Identity,
  batch: ActivityBatch,
  extraTags: string[][] = [],
): Promise<void> {
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
      tags: [['h', channelId], ['t', ACTIVITY_TAG], ['session', batch.sessionId], ...extraTags],
      content,
    },
    owner.secretKey,
  );

  await publishEvent(event, owner);
}

/** Emit an ordered batch of ACP session updates as one kind:9 channel event. */
async function emitActivityEvent(
  channelId: string,
  owner: Identity,
  batch: ActivityBatch,
): Promise<void> {
  try {
    await postAgentActivityBatch(channelId, owner, batch);
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
