import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { type TurnTokenFigure } from './harness-turn-tokens.js';
import { toolCallEntries } from './acp.js';



/** Bound on the stderr tail kept for an exit-failure error message. */
export const STDERR_TAIL_MAX_CHARS = 2_000;


export function braceDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === '{') delta += 1;
    else if (char === '}') delta -= 1;
  }
  return delta;
}


/**
 * Harness stderr worth carrying into a failure reason.
 *
 * pi-acp 0.0.33 answers our ACP `notifications/initialized` with `-32601
 * Method not found` and dumps the whole notification to stderr on EVERY
 * session, then serves the session fine. Gluing that block onto every timeout
 * made each pi failure read as a handshake fault it never was, so a dumped
 * notification-handling block is dropped here and the client no longer sends
 * that notification to pi at all. Anything else the harness wrote is kept: a
 * real cause still belongs in the reason.
 */
export function meaningfulHarnessStderr(tail: string): string {
  const lines = tail.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/error handling notification/i.test(line)) {
      kept.push(line);
      continue;
    }
    const block = [line];
    let depth = braceDelta(line);
    // The dumped notification is either braced on the header line or on the
    // lines that follow it; consume the whole object either way.
    if (depth === 0 && lines[index + 1]?.trimStart().startsWith('{')) {
      index += 1;
      block.push(lines[index]!);
      depth = braceDelta(lines[index]!);
    }
    while (depth > 0 && index + 1 < lines.length) {
      index += 1;
      block.push(lines[index]!);
      depth += braceDelta(lines[index]!);
    }
    if (!/notifications\/initialized/.test(block.join('\n'))) kept.push(...block);
  }
  return kept.join('\n').trim();
}


/** One Room line: a multiline quota dump must keep its reset time through first-line distill. */
export function flattenHarnessCause(tail: string): string {
  return meaningfulHarnessStderr(tail).replace(/\s+/g, ' ').trim();
}


/** Preserve the remote JSON-RPC code for callers classifying a precise refusal. */
export class AcpRequestError extends Error {
  constructor(readonly code: number | undefined, message: string) {
    super(message);
  }
}


export class AcpRuntimeExitedError extends Error {
  override readonly cause = 'runtime_exited';
  constructor(detail: string) {
    super(`runtime_exited: ${detail}`);
    this.name = 'AcpRuntimeExitedError';
  }
}


export class AcpResourceLimitError extends Error {
  override readonly cause = 'resource_limit';
  constructor(memoryMaxBytes: number) {
    super(`resource_limit: ACP session likely hit its ${Math.floor(memoryMaxBytes / 1024 / 1024)} MiB memory limit (exit 137 or signal 9)`);
    this.name = 'AcpResourceLimitError';
  }
}


export function killChildProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    // The harness may have exited between the liveness check and the signal.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}


export interface McpServerWire {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}


export interface SessionUpdate {
  sessionId: string;
  update: Record<string, unknown>;
}


export interface ToolCallEntry {
  id?: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  resultReceived?: boolean;
  rawInput?: unknown;
  content?: unknown;
  /** Some harnesses (grok) put a failed call's reason here and nowhere else. */
  rawOutput?: unknown;
  locations?: unknown;
}


export interface PromptResult {
  stopReason: string;
  updates: SessionUpdate[];
  /** Concatenated agent text from message chunks. */
  agentText: string;
  toolCalls: ToolCallEntry[];
  /** Present only when the harness result included a token figure. */
  tokenUsage?: TurnTokenFigure;
}


/** One `session/prompt` content block: text, or an inline image for a harness that advertises `promptCapabilities.image`. */
export type AcpPromptBlock =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };


export interface SteerResult {
  runId: string;
  messageId: string;
}


export interface AcpPermissionOption {
  kind?: string;
  optionId?: string;
  name?: string;
}


/** One command/skill an ACP harness advertises via `available_commands_update`. */
export interface AcpAvailableCommand {
  name: string;
  description?: string;
  inputHint?: string;
}


/**
 * Defensively parse an `available_commands_update` payload. Malformed entries
 * are dropped, never thrown — a harness advertising junk must not break the
 * session-update pipeline that activity projection rides on.
 */
export function parseAvailableCommands(value: unknown): AcpAvailableCommand[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: AcpAvailableCommand[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const rawName = typeof record.name === 'string' ? record.name.trim().replace(/^\/+/, '') : '';
    if (!rawName || rawName.length > 80 || seen.has(rawName)) continue;
    seen.add(rawName);
    const description =
      typeof record.description === 'string' && record.description.trim()
        ? record.description.trim().slice(0, 300)
        : undefined;
    const input = record.input as { hint?: unknown } | undefined;
    const hintRaw = input && typeof input.hint === 'string' ? input.hint : undefined;
    const inputHint = hintRaw && hintRaw.trim() ? hintRaw.trim().slice(0, 120) : undefined;
    result.push({
      name: rawName,
      ...(description ? { description } : {}),
      ...(inputHint ? { inputHint } : {}),
    });
    if (result.length >= 200) break;
  }
  return result;
}


export interface AcpPermissionRequest {
  sessionId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    [key: string]: unknown;
  };
  options?: AcpPermissionOption[];
  [key: string]: unknown;
}


export type AcpPermissionDecision = 'allow' | 'reject';

export type AcpPermissionHandler = (
  request: AcpPermissionRequest,
) => Promise<AcpPermissionDecision>;

/** A fail-closed list of host-owned permission requests for restricted sessions. */
export type AcpPermissionAllowlist = (request: AcpPermissionRequest) => boolean;


/** Invoked once per incremental `agent_message_chunk` delta during a live prompt. */
export type AcpTextChunkHandler = (
  delta: string,
  fullTextSoFar: string,
  /** The normalized assistant-message run currently accumulating. */
  currentRun?: string,
  runs?: readonly string[],
) => void;


export type AcpStreamSnapshot = {
  /** The one currently accumulating durable answer run. */
  messageText: string;
  /** The latest replace-in-place reasoning/progress line. */
  thoughtText?: string;
};


/** Invoked on every ACP update so a tool boundary can move progress out of message. */
export type AcpStreamHandler = (snapshot?: AcpStreamSnapshot) => void;


/**
 * True when an `agent_message_chunk` is pi-acp's own relay of a Pi extension's
 * `ctx.ui.notify()` call (tagged `_meta.piAcp.notify`), not model output. Pi's
 * bundled MCP extension calls `notify()` with "MCP servers need attention:
 * …\nRun /mcp to fix." whenever a mounted server (CodeGraph among them) is
 * `failed` or `needs-auth` at session start, and pi-acp has no ACP vocabulary
 * for an extension-level notice other than `agent_message_chunk` — so without
 * this check that infrastructure text is indistinguishable from the model's
 * own words and can stand in as the agent's entire reply when it is the only
 * chunk the turn produced.
 */
export function isHarnessNotifyChunk(update: Record<string, unknown>): boolean {
  const meta = update._meta as Record<string, unknown> | undefined;
  const piAcp = meta?.piAcp as Record<string, unknown> | undefined;
  return Boolean(piAcp?.notify);
}


/** Extract the text delta of an `agent_message_chunk` update, harness-agnostic. */
export function agentMessageChunkText(update: Record<string, unknown>): string {
  if (update.sessionUpdate !== 'agent_message_chunk') return '';
  if (isHarnessNotifyChunk(update)) return '';
  const content = update.content as { type?: string; text?: string } | undefined;
  if (content?.type === 'text') return content.text ?? '';
  if (typeof update.content === 'string') return update.content;
  return '';
}


/**
 * A delta that binds to the word right before it, so it can only be a
 * continuation of the same sentence and never the start of a fresh thought:
 * an elided-word apostrophe ("I" + "'ll"), a hyphen, closing or sentence
 * punctuation, or its own leading whitespace (which already separates the two
 * runs on its own).
 *
 * This is the stream-head defect that made a corner's first message render as
 * `'ll take a look at the README first.` — a non-text update landing between
 * the model's first token and its second one earned a synthetic paragraph
 * break mid-word, and the growing draft then presented the one-character head
 * (`I`) as if it were a complete thought.
 */
export const CHUNK_CONTINUES_PREVIOUS_WORD = /^[\s'\u2018\u2019\u02bc.,!?;:%)\]}-]/;


/**
 * Whether `delta` continues the word `current` stops on, so the non-text
 * update between them was interleaved metadata rather than a message
 * boundary. Only `CHUNK_CONTINUES_PREVIOUS_WORD` qualifies — a head that
 * binds backwards and cannot open a message. A letter or digit head does
 * not; see UNRESOLVED PROTOCOL AMBIGUITY below before widening this.
 *
 * ── UNRESOLVED PROTOCOL AMBIGUITY: a word-character resume ────────────────
 *
 * When a run stops part-way through a word and the next delta opens with a
 * letter or a digit, the two readings are indistinguishable, in either case:
 *
 *     "Using Git"        + tool_call + "Hub works."        → one name, split
 *     "Checking Docker"  + tool_call + "Found it."         → two messages
 *     "The ans"          + tool_call + "wer is 42."        → one word, split
 *     "Checking package" + tool_call + "npm test passes."  → two messages
 *
 * Same text; from a harness that emits a bare `tool_call`, the same update
 * stream. Capitalization does not separate the first pair and lowercase does
 * not separate the second — `npm`, `ls` and `git` open messages exactly as
 * `Found` does. A single string-valued final message therefore has three
 * possible values at that seam, and all three were built and run end to end
 * on the branch that added this guard:
 *
 *   1. join with no separator — fuses two real messages ("DockerFound it.")
 *   2. end the run — the split word loses its head ("Hub works.")   ← chosen
 *   3. join across a paragraph break — keeps both, but promotes unpunctuated
 *      interim narration into the reply, changing the final-message contract
 *
 * Reading 2 is in force by decision, to hold that contract: interim
 * narration stays in the live draft and only the final post-tool message is
 * the reply. The cost is real and is asserted in `leaves a word-character
 * resume ambiguous instead of guessing at it` — a word split across such a
 * seam still loses its head, exactly as before this guard existed.
 *
 * Resolving it needs a structural signal, and the repository was searched
 * for one before settling on reading 2. There is none to be had today:
 *
 *   - Nothing in ACP groups message deltas. `toolCallId` is exactly the key
 *     message chunks lack, which is why `toolCallEntries` below is trivially
 *     correct and this function cannot be.
 *   - The only verbatim harness captures held here are
 *     `fixtures/grok-use-tool-permissions.ts` and
 *     `fixtures/claude-agent-acp-permissions.ts`, both `tool_call` and
 *     `session/request_permission` frames. Neither records a message chunk.
 *   - The `_meta` a real harness does send is tool identity (`x.ai/tool`) or
 *     per-turn identity (`goose.activeRunId`, read at
 *     `activeRunIdFromUpdate`). Neither is per-message. `messageId` exists in
 *     ACP only as a steer RPC's result, never on a stream update.
 *   - The `_meta.goose.created` stamp that appears in `acp.test.ts` is
 *     invented by a hand-written fake; no production code reads it.
 *   - PRODUCTION-CORPUS REPLAY does not cover this. Its fixture is sanitized
 *     relay events whose ACP payloads were replaced before commit.
 *
 * A harness message id or stop marker on `agent_message_chunk` would end the
 * ambiguity outright, since two deltas of one message would then be
 * identifiable as such. Settling whether any installed harness already sends
 * one means capturing raw `session/update` frames per harness — the old
 * `scripts/capture-acp-permissions.mjs` (deleted; see git history) did
 * exactly that and is the shape of the job.
 *
 * Until then do not reach for the text. Capitalization was tried four ways —
 * the word's own case, a prefix allowlist, the fragment's length, whether
 * the word had already turned over — and lowercase once; each reading
 * resolved one pair above by corrupting the other.
 */
export function continuesPreviousWord(current: string, delta: string, afterTool = false): boolean {
  if (/\s$/.test(current)) return false;
  // A tool call ends a message when the text that resumes opens on a line
  // break: a word cannot continue across one, so the break is the model
  // starting its next text block. Claude's post-tool text can open with
  // `\n\n`, and joining it kept the pre-tool sentence at the top of the
  // reply. Other metadata keeps the old reading.
  if (afterTool && /^\r?\n/.test(delta)) return false;
  return CHUNK_CONTINUES_PREVIOUS_WORD.test(delta);
}


export const TOOL_UPDATE_TYPES = new Set(['tool_call', 'tool_call_update', 'tool_result']);


export const PI_ACP_HARNESS = /(^|[/\\])pi-acp(?:\.[a-z]+)?$/i;


/** Whether the configured harness label is pi's ACP adapter (`pi-acp`). */
export function isPiAcpHarness(agentLabel: string | undefined): boolean {
  return Boolean(agentLabel && PI_ACP_HARNESS.test(agentLabel));
}


/**
 * pi-acp 0.0.33 forwards the model's text deltas verbatim (`handlePiEvent` →
 * `text_delta` → `text: ame.delta`, no line-ending framing), so no
 * normalization is needed. This remains the named seam for the stream-delta
 * pipeline; the previous `withoutOneTrailingLineEnding` framing workaround
 * was deleted after that check — it ate authored line endings and glued
 * numbered-list items together.
 */
export function normalizeStreamDelta(text: string, _agentLabel?: string): string {
  return text;
}


/** Group streaming text into assistant-message runs separated by tool,
 * reasoning, or plan updates. Consecutive deltas are one message. A resuming
 * delta that binds to the prior word remains in that message too, since some
 * harnesses interleave metadata in the middle of a token.
 *
 * The split is decided when the next delta arrives, never when the non-text
 * update lands: a tool call used to close the run on sight, so a tool call
 * between a word's first and second token broke the word in two and the head
 * stopped being part of the final message. Whether the run ended is only
 * knowable from what resumes it. */
export function agentMessageRuns(updates: readonly SessionUpdate[], agentLabel?: string): string[] {
  return agentMessageRunSpans(updates, agentLabel).map((run) => run.text);
}


/** Each message run with the index of the update that opened it. */
export function agentMessageRunSpans(
  updates: readonly SessionUpdate[],
  agentLabel?: string,
): { text: string; at: number }[] {
  const runs: { text: string; at: number }[] = [];
  let current = '';
  let at = 0;
  let lastWasText = false;
  let toolSinceText = false;
  for (const [index, u] of updates.entries()) {
    const delta = normalizeStreamDelta(agentMessageChunkText(u.update), agentLabel);
    if (!delta) {
      lastWasText = false;
      if (TOOL_UPDATE_TYPES.has(u.update.sessionUpdate as string)) toolSinceText = true;
      continue;
    }
    if (!lastWasText && current && !continuesPreviousWord(current, delta, toolSinceText)) {
      runs.push({ text: current, at });
      current = '';
    }
    if (!current) at = index;
    current += delta;
    lastWasText = true;
    toolSinceText = false;
  }
  if (current) runs.push({ text: current, at });

  // A reconnecting or noisy harness can replay a completed message run. Keep
  // the first occurrence so both the live draft and final selection are
  // stable for a turn, while repeated token text inside one uninterrupted run
  // ("very very") remains untouched.
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (seen.has(run.text)) return false;
    seen.add(run.text);
    return true;
  });
}


/**
 * Harness retry/backoff narration (pi flaking mid-turn is the live case:
 * `Retrying (attempt 1/3, waiting 2s)...Retrying...Retry finished, resuming.`)
 * arrives as ordinary `agent_message_chunk` text, so structurally it is
 * indistinguishable from prose. Classification is therefore by CONTENT, and
 * deliberately narrow: a message counts as pure narration only when, after
 * removing recognized retry-narration fragments, nothing but separators
 * remains. A genuine answer that merely mentions retries keeps most of its
 * words and never classifies as narration.
 */
export const RETRY_NARRATION_FRAGMENTS: RegExp[] = [
  // `Retrying (attempt 2/3, waiting 4s)` — the pi/ox-alpha shape.
  /retrying\s*\((?:attempt|try)\s*\d+\s*\/\s*\d+(?:,\s*(?:waiting|backoff)\s*\d+(?:\.\d+)?s)?\)/gi,
  // A bare `(attempt 2/3...)` or `[attempt 2/3]` qualifier on its own.
  /[([](?:attempt|try)\s*\d+\s*\/\s*\d+(?:,\s*(?:waiting|backoff)\s*\d+(?:\.\d+)?s)?[))]\s*/gi,
  // Standalone narration words with their optional trailing ellipsis.
  /retrying\s*\.{0,3}/gi,
  /retried\s*\.{0,3}/gi,
  /retry\s+finished,?\s*/gi,
  /retry\s+failed,?\s*/gi,
  /resuming\.?/gi,
  /waiting\s+\d+(?:\.\d+)?s/gi,
];


/** True only when the WHOLE text is harness retry/backoff narration. Empty
 *  text is not narration (callers treat emptiness separately), and any message
 *  with a single word of its own content left over is genuine prose. */
export function isPureRetryNarration(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  let rest = trimmed;
  for (const fragment of RETRY_NARRATION_FRAGMENTS) {
    rest = rest.replace(fragment, '');
  }
  return !/[\w]/.test(rest);
}


/** Only the LAST assistant-message run is the turn's durable final output;
 *  earlier runs are progress narration around tool work and never join it
 *  (a corner may record those runs independently as durable output activity).
 *  Retry/backoff narration can never be the answer either: classify that last
 *  run and return empty when it is pure narration, so a flaked turn selects
 *  nothing (the caller treats the turn as failed and stays retryable) while
 *  genuine prose — including prose that merely mentions retries — is kept.
 *  Never scan backwards past the last run: an earlier pre-tool progress
 *  sentence is not the answer just because the turn later degraded into
 *  retry narration. */
export function finalAgentMessageText(
  updates: readonly SessionUpdate[],
  agentLabel?: string,
): string {
  const runs = agentMessageRunSpans(updates, agentLabel);
  const last = runs[finalRunIndex(runs)]?.text;
  if (!last || isPureRetryNarration(last)) return '';
  return last;
}


/** The last run with any text in it: a whitespace-only run is not an answer. */
export function finalRunIndex(runs: readonly { text: string }[]): number {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index]!.text.trim()) return index;
  }
  return -1;
}


/** One step of a turn, in stream order: an earlier text run or a tool call. */
export type AgentTurnStep =
  | { kind: 'note'; text: string }
  | { kind: 'tool'; call: ToolCallEntry };


/**
 * Everything a turn did besides its reply, in the order it happened: every
 * text run except the final one (`finalAgentMessageText`) as a note, and
 * every tool call. A Room posts the final run as the reply and these as the
 * reply's steps, so text written before a tool call is kept without leading
 * the answer. Retry narration is harness noise, not the agent's text, and is
 * dropped.
 */
export function agentTurnSteps(
  updates: readonly SessionUpdate[],
  agentLabel?: string,
): AgentTurnStep[] {
  const runs = agentMessageRunSpans(updates, agentLabel);
  const final = finalRunIndex(runs);
  const steps: { at: number; step: AgentTurnStep }[] = runs.flatMap((run, index) =>
    index === final || !run.text.trim() || isPureRetryNarration(run.text)
      ? []
      : [{ at: run.at, step: { kind: 'note' as const, text: run.text.trim() } }],
  );
  const calls = toolCallEntries(updates);
  const opened = toolCallOpenings(updates);
  calls.forEach((call, index) => {
    steps.push({ at: opened[index] ?? updates.length, step: { kind: 'tool', call } });
  });
  return steps.sort((left, right) => left.at - right.at).map(({ step }) => step);
}


/** The update index that opened each entry of `toolCallEntries`, same order. */
export function toolCallOpenings(updates: readonly SessionUpdate[]): number[] {
  const opened = new Map<string, number>();
  let anonymous = 0;
  let activeAnonymous: string | undefined;
  for (const [index, { update }] of updates.entries()) {
    const sessionUpdate = update.sessionUpdate as string | undefined;
    if (!sessionUpdate || !TOOL_UPDATE_TYPES.has(sessionUpdate)) continue;
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    if (id) activeAnonymous = undefined;
    if (!id && (sessionUpdate === 'tool_call' || !activeAnonymous)) {
      activeAnonymous = `anonymous-${anonymous++}`;
    }
    const key = id ?? activeAnonymous!;
    if (!opened.has(key)) opened.set(key, index);
    if (!id && sessionUpdate === 'tool_result') activeAnonymous = undefined;
  }
  return [...opened.values()];
}


/**
 * The stream-level fact about a turn that ended with no answer text, for a
 * failure reason: what the harness said the stop was, what the stream carried
 * instead (reasoning only, tool calls only, nothing at all), and whether the
 * last message run was retry narration. Never the bare "no reply".
 */
export function describeEmptyTurn(result: PromptResult, agentLabel?: string): string {
  const counts = new Map<string, number>();
  for (const { update } of result.updates) {
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : 'unknown';
    if (kind === 'session_info_update' || kind === 'available_commands_update') continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const stream = counts.size
    ? `the stream carried only ${[...counts].map(([kind, count]) => `${kind}×${count}`).join(', ')}`
    : 'the stream carried no content updates';
  const lastRun = agentMessageRuns(result.updates, agentLabel).at(-1);
  const narration =
    lastRun && isPureRetryNarration(lastRun)
      ? `; the last message was retry narration "${lastRun.trim().slice(0, 80)}"`
      : '';
  return `harness ended the turn (${result.stopReason}) with no answer text; ${stream}${narration}`;
}


export function updateText(update: Record<string, unknown>): string {
  const content = update.content as { type?: string; text?: string } | string | undefined;
  if (typeof content === 'string') return content;
  return content?.type === 'text' ? (content.text ?? '') : '';
}


export const THOUGHT_UPDATE_TYPES = new Set([
  'agent_thought_chunk',
  'agent_thought',
  'reasoning',
  'reasoning_chunk',
  'thinking',
  'thinking_chunk',
  'analysis',
  'analysis_chunk',
  'progress',
  'progress_update',
]);


/** Derive the three-lane live view from the exact ordered ACP update stream. */
export function agentStreamSnapshot(
  updates: readonly SessionUpdate[],
  agentLabel?: string,
): AcpStreamSnapshot {
  const completedMessages: string[] = [];
  let messageText = '';
  let lastWasMessage = false;
  let thoughtText = '';
  let thoughtRunOpen = false;
  let toolSinceMessage = false;
  for (const { update } of updates) {
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
    if (kind === 'agent_message_chunk') {
      const delta = normalizeStreamDelta(agentMessageChunkText(update), agentLabel);
      if (!delta) continue;
      if (
        !lastWasMessage &&
        messageText &&
        !continuesPreviousWord(messageText, delta, toolSinceMessage)
      ) {
        if (!completedMessages.includes(messageText)) completedMessages.push(messageText);
        messageText = '';
      }
      messageText += delta;
      lastWasMessage = true;
      thoughtRunOpen = false;
      toolSinceMessage = false;
      continue;
    }
    if (TOOL_UPDATE_TYPES.has(kind)) toolSinceMessage = true;
    if (lastWasMessage && messageText) {
      if (!completedMessages.includes(messageText)) completedMessages.push(messageText);
      messageText = '';
    }
    lastWasMessage = false;
    if (THOUGHT_UPDATE_TYPES.has(kind)) {
      const delta = normalizeStreamDelta(updateText(update), agentLabel);
      if (!delta) continue;
      if (!thoughtRunOpen) thoughtText = '';
      thoughtText += delta;
      thoughtRunOpen = true;
    } else {
      thoughtRunOpen = false;
    }
  }
  return {
    messageText,
    ...(thoughtText || completedMessages.length
      ? { thoughtText: thoughtText || completedMessages.at(-1)! }
      : {}),
  };
}
