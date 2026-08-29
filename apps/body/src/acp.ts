/**
 * Minimal ACP client over stdio for an ACP coding agent.
 *
 * Wire protocol (buzz-agent ACP, NOT MCP):
 *   - initialize: protocolVersion is u32 (1), uses clientCapabilities
 *   - session/new: returns { sessionId, models }
 *   - session/prompt: sends prompt as array of {type, text}
 *   - session/update: notification from agent with { sessionId, update }
 *   - session/request_permission: request from agent with options
 *
 * Rationale (see PR): stock buzz-acp auto-approves permissions, mounts at most
 * one MCP via env, and does not project session/update onto the relay. The body
 * therefore drives the selected ACP server directly so session modes/MCP mounts
 * stay enforceable and multi-user activity projection remains possible.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { SessionMode } from './config.js';
import {
  cornerAutonomyModeCandidates,
  harnessSupportsNativeSessionResume,
} from './harness-capabilities.js';
import { harnessReadsMetaSystemPrompt, sessionToolScopeMeta } from './harness-tool-scope.js';

/** Bound on the stderr tail kept for an exit-failure error message. */
const STDERR_TAIL_MAX_CHARS = 2_000;

/** Stable startup failure surfaced by bounded functional-update probes. */
export class AcpRequestTimeoutError extends Error {
  readonly code = 'ACP_REQUEST_TIMEOUT';

  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    stderrTail = '',
    readonly inactivity = false,
  ) {
    const suffix = stderrTail.trim() ? `; harness stderr: ${stderrTail.trim()}` : '';
    super(
      `ACP ${method} timed out after ${timeoutMs}ms${inactivity ? ' of inactivity' : ''}${suffix}`,
    );
    this.name = 'AcpRequestTimeoutError';
  }
}

function killChildProcessGroup(
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
  title?: string;
  kind?: string;
  status?: string;
}

export interface PromptResult {
  stopReason: string;
  updates: SessionUpdate[];
  /** Concatenated agent text from message chunks. */
  agentText: string;
  toolCalls: ToolCallEntry[];
}

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

/** Invoked once per incremental `agent_message_chunk` delta during a live prompt. */
export type AcpTextChunkHandler = (delta: string, fullTextSoFar: string) => void;

export type AcpStreamSnapshot = {
  /** The one currently accumulating durable answer run. */
  messageText: string;
  /** The latest replace-in-place reasoning/progress line. */
  thoughtText?: string;
};

/** Invoked on every ACP update so a tool boundary can move progress out of message. */
export type AcpStreamHandler = (snapshot?: AcpStreamSnapshot) => void;

/** Extract the text delta of an `agent_message_chunk` update, harness-agnostic. */
function agentMessageChunkText(update: Record<string, unknown>): string {
  if (update.sessionUpdate !== 'agent_message_chunk') return '';
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
const CHUNK_CONTINUES_PREVIOUS_WORD = /^[\s'\u2018\u2019\u02bc.,!?;:%)\]}-]/;

const PI_ACP_HARNESS = /(^|[/\\])pi-acp(?:\.[a-z]+)?$/i;

function withoutOneTrailingLineEnding(text: string): string {
  if (/\r?\n\r?\n$/.test(text)) return text;
  return text.replace(/\r?\n$/, '');
}

/**
 * pi-acp frames each incremental text token with one line ending. Treating
 * that transport delimiter as authored Markdown renders every token as a
 * paragraph and can split a word (`be\n` + `eline\n`). Remove one terminal
 * frame from every Pi delta while preserving explicit blank lines.
 */
function normalizeStreamDelta(text: string, agentLabel?: string): string {
  return agentLabel && PI_ACP_HARNESS.test(agentLabel) ? withoutOneTrailingLineEnding(text) : text;
}

/** Group streaming text into assistant-message runs separated by tool,
 * reasoning, or plan updates. Consecutive deltas are one message. A resuming
 * delta that binds to the prior word remains in that message too, since some
 * harnesses interleave metadata in the middle of a token. */
function agentMessageRuns(updates: readonly SessionUpdate[], agentLabel?: string): string[] {
  const runs: string[] = [];
  let current = '';
  let lastWasText = false;
  for (const u of updates) {
    const delta = normalizeStreamDelta(agentMessageChunkText(u.update), agentLabel);
    if (!delta) {
      lastWasText = false;
      continue;
    }
    if (
      !lastWasText &&
      current &&
      !/\s$/.test(current) &&
      !CHUNK_CONTINUES_PREVIOUS_WORD.test(delta)
    ) {
      runs.push(current);
      current = '';
    }
    current += delta;
    lastWasText = true;
  }
  if (current) runs.push(current);

  // A reconnecting or noisy harness can replay a completed message run. Keep
  // the first occurrence so both the live draft and final selection are
  // stable for a turn, while repeated token text inside one uninterrupted run
  // ("very very") remains untouched.
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (seen.has(run)) return false;
    seen.add(run);
    return true;
  });
}

/** Accumulated non-chat draft text shown while the turn is still running. */
function joinAgentMessageChunks(updates: readonly SessionUpdate[], agentLabel?: string): string {
  return agentMessageRuns(updates, agentLabel).join('\n\n');
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
const RETRY_NARRATION_FRAGMENTS: RegExp[] = [
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
 *  earlier runs are progress narration around tool work and stay draft-only.
 *  Retry/backoff narration can never be the answer either: classify that last
 *  run and return empty when it is pure narration, so a flaked turn selects
 *  nothing (the caller treats the turn as failed and stays retryable) while
 *  genuine prose — including prose that merely mentions retries — is kept.
 *  Never scan backwards past the last run: an earlier pre-tool progress
 *  sentence is not the answer just because the turn later degraded into
 *  retry narration. */
function finalAgentMessageText(updates: readonly SessionUpdate[], agentLabel?: string): string {
  const last = agentMessageRuns(updates, agentLabel).at(-1);
  if (!last || isPureRetryNarration(last)) return '';
  return last;
}

function updateText(update: Record<string, unknown>): string {
  const content = update.content as { type?: string; text?: string } | string | undefined;
  if (typeof content === 'string') return content;
  return content?.type === 'text' ? (content.text ?? '') : '';
}

const THOUGHT_UPDATE_TYPES = new Set([
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
  for (const { update } of updates) {
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
    if (kind === 'agent_message_chunk') {
      const delta = normalizeStreamDelta(agentMessageChunkText(update), agentLabel);
      if (!delta) continue;
      if (
        !lastWasMessage &&
        messageText &&
        !/\s$/.test(messageText) &&
        !CHUNK_CONTINUES_PREVIOUS_WORD.test(delta)
      ) {
        if (!completedMessages.includes(messageText)) completedMessages.push(messageText);
        messageText = '';
      }
      messageText += delta;
      lastWasMessage = true;
      thoughtRunOpen = false;
      continue;
    }
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

/**
 * ACP tool kinds are intentionally portable and runtimes sometimes put the
 * concrete tool name in the title or raw input. Treat shell/execute as
 * mutating because an arbitrary command can cross the write boundary.
 */
export function isMutatingPermissionRequest(request: AcpPermissionRequest): boolean {
  const tool = request.toolCall;
  const kind = tool?.kind?.toLowerCase();
  if (kind && ['edit', 'execute', 'delete', 'move'].includes(kind)) return true;
  const description = [tool?.title, tool?.rawInput]
    .filter((value) => value !== undefined)
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ')
    .toLowerCase();
  return /(^|[^a-z])(str_replace|write|edit|shell|bash|execute|create|delete|remove|move|rename|patch|apply_patch)([^a-z]|$)/.test(
    description,
  );
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Idle window used to re-arm `timer` on activity; undefined for non-resettable requests. */
  idleTimeoutMs?: number;
  method?: string;
}

export class AcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private activeRunIds = new Map<string, string>();
  private activePromptSessions = new Set<string>();
  /** Tool metadata arrives in session/update just before a sparse permission request. */
  private toolCallMetadata = new Map<string, AcpPermissionRequest['toolCall']>();
  /** Latest `available_commands_update` per session, keyed by sessionId. */
  private sessionCommands = new Map<string, AcpAvailableCommand[]>();
  private supportsStandardSteering = false;
  private supportsSessionLoading = false;
  private alive = false;
  /** Bounded tail of recent stderr, so a spawn/exit failure's rejection text
   *  carries the real reason (e.g. a harness's own "missing API key" notice)
   *  instead of just the bare exit code, in the daemon's log. */
  private stderrTail = '';
  private agentEnv: Record<string, string>;
  private agentCommand: string;
  private agentLabel: string;
  private agentArgs: string[];
  private agentCwd?: string;
  private inheritProcessEnv: boolean;
  private autoApprove: boolean;
  private permissionHandler?: AcpPermissionHandler;

  constructor(opts: {
    /** Legacy bare-binary option. Prefer agentCommand + agentArgs. */
    agentBinary?: string;
    agentCommand?: string;
    agentArgs?: string[];
    /**
     * Human name for the harness in error text. When the daemon wraps the child
     * in an OS sandbox (`bwrap-sandbox.ts`), `agentCommand` is `bwrap` — but a
     * spawn/exit failure has to name the harness the operator configured, not
     * the wrapper, or every harness crash is logged as a bubblewrap crash.
     */
    agentLabel?: string;
    agentEnv: Record<string, string>;
    /**
     * Working directory for the child process. The ACP session `cwd` is a
     * protocol parameter, so without this a harness that keys per-project
     * state off its own process cwd sees the daemon's directory for every
     * Room and corner.
     */
    agentCwd?: string;
    /**
     * Restore the pre-allowlist behaviour of spreading the daemon's whole
     * `process.env` underneath `agentEnv`. Escape hatch only — see
     * `buildAgentEnv`'s passthrough set.
     */
    inheritProcessEnv?: boolean;
    autoApprovePermissions?: boolean;
    permissionHandler?: AcpPermissionHandler;
  }) {
    super();
    const command = opts.agentCommand ?? opts.agentBinary;
    if (!command) throw new Error('ACP agent command is required');
    this.agentCommand = command;
    this.agentLabel = opts.agentLabel ?? command;
    this.agentArgs = [...(opts.agentArgs ?? [])];
    this.agentEnv = opts.agentEnv;
    if (opts.agentCwd) this.agentCwd = opts.agentCwd;
    this.inheritProcessEnv =
      opts.inheritProcessEnv ?? process.env.BUZZY_BODY_AGENT_ENV_INHERIT === '1';
    this.autoApprove = opts.autoApprovePermissions ?? true;
    this.permissionHandler = opts.permissionHandler;
  }

  async start(timeoutMs = 60_000): Promise<void> {
    if (this.alive) return;
    this.child = spawn(this.agentCommand, this.agentArgs, {
      // agentEnv is the child's whole environment: buildAgentEnv's allowlist is
      // a real boundary, not a decorative one layered over a full inherit.
      env: this.inheritProcessEnv ? { ...process.env, ...this.agentEnv } : this.agentEnv,
      ...(this.agentCwd ? { cwd: this.agentCwd } : {}),
      // The harness and every tool it spawns share a disposable process
      // group. A hard turn deadline can therefore retire the whole tree,
      // never just the ACP parent while a shell/compiler keeps running.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.alive = true;

    this.stderrTail = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
      this.emit('stderr', chunk);
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));

    this.child.on('exit', (code, signal) => {
      this.alive = false;
      const stderrSuffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : '';
      for (const [, p] of this.pending) {
        this.clearTimer(p);
        p.reject(
          new Error(
            `ACP agent ${this.agentLabel} exited code=${code} signal=${signal}${stderrSuffix}`,
          ),
        );
      }
      this.pending.clear();
      this.activeRunIds.clear();
      this.activePromptSessions.clear();
      this.toolCallMetadata.clear();
      this.sessionCommands.clear();
      this.emit('exit', { code, signal });
    });

    this.child.on('error', (err) => {
      // An ENOENT/unspawnable command never emits 'exit', so without this the
      // in-flight `initialize` request (and every later one) would hang until
      // its full timeout instead of failing now — which is what a catalog
      // probe or a session spawn against a broken agent binary needs.
      this.alive = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      // EventEmitter's 'error' event is special: emitting it with no
      // listener attached throws the error as an uncaught exception instead
      // of merely going unheard. No caller currently subscribes to this
      // instance's 'error' event (the rejected `pending` requests above are
      // the real, always-observed failure path), so guard the emit.
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });

    // ACP handshake: initialize, then send initialized notification.
    const initResult = (await this.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {},
      },
      timeoutMs,
    )) as Record<string, unknown>;
    const initMeta = initResult._meta as Record<string, unknown> | undefined;
    const steering = initMeta?.steering as Record<string, unknown> | undefined;
    this.supportsStandardSteering = steering?.supported === true;
    const agentCapabilities = initResult.agentCapabilities as { loadSession?: unknown } | undefined;
    this.supportsSessionLoading = agentCapabilities?.loadSession === true;
    this.emit('initialized', initResult);
    this.notify('notifications/initialized', {});
  }

  async stop(): Promise<void> {
    if (!this.alive) return;
    const child = this.child;
    if (!child) return;
    try {
      // Send shutdown if child is still alive.
      if (this.child?.stdin.writable) {
        this.notify('shutdown', {});
      }
    } catch {
      /* ignore */
    }
    // Give it time to flush.
    await new Promise<void>((r) => setTimeout(r, 300));
    try {
      killChildProcessGroup(child, 'SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => setTimeout(r, 500));
    try {
      killChildProcessGroup(child, 'SIGKILL');
    } catch {
      /* ignore */
    }
    this.child = null;
    this.alive = false;
    this.activeRunIds.clear();
    this.activePromptSessions.clear();
    this.toolCallMetadata.clear();
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** Host pid of the harness wrapper (bwrap when enabled). */
  processPid(): number | undefined {
    return this.child?.pid;
  }

  /** The latest command list this harness advertised for a session, if any. */
  sessionCommandsFor(sessionId: string): AcpAvailableCommand[] {
    return this.sessionCommands.get(sessionId) ?? [];
  }

  /** Whether this live ACP process advertised the stable `session/load` method. */
  canLoadSession(): boolean {
    return this.supportsSessionLoading;
  }

  async sessionNew(opts: {
    cwd: string;
    mcpServers?: McpServerWire[];
    systemPrompt?: string;
    /** Ask agents with ACP modes to enforce the Body session boundary. */
    mode?: SessionMode;
    /** Bounded startup probes use a shorter fail-fast deadline. */
    timeoutMs?: number;
  }): Promise<{ sessionId: string; raw: unknown }> {
    const params: Record<string, unknown> = {
      cwd: opts.cwd,
      mcpServers: (opts.mcpServers ?? []).map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? [],
      })),
    };
    if (opts.systemPrompt) params.systemPrompt = opts.systemPrompt;
    // The tool-scope lockdown is applied HERE, not at the call sites, so a new
    // session path cannot ship without it: every session/new this daemon sends
    // pins the harness to the servers listed on the same request. See
    // `harness-tool-scope.ts` for what each harness actually honours.
    //
    // `agentLabel`, NOT `agentCommand`: under the OS sandbox the spawn command
    // is `bwrap` and the harness is only an argument to it, so matching on the
    // command would classify every sandboxed session as an unknown harness and
    // silently send no lockdown at all.
    const meta: Record<string, unknown> = {
      ...(sessionToolScopeMeta(this.agentLabel) ?? {}),
    };
    // claude-agent-acp reads the system prompt only from `_meta.systemPrompt`;
    // its top-level `systemPrompt` sibling above is silently ignored there.
    if (opts.systemPrompt && harnessReadsMetaSystemPrompt(this.agentLabel)) {
      meta.systemPrompt = { append: opts.systemPrompt };
    }
    if (Object.keys(meta).length > 0) params._meta = meta;
    const raw = (await this.request('session/new', params, opts.timeoutMs ?? 60_000)) as Record<
      string,
      unknown
    >;
    const sessionId = raw.sessionId as string | undefined;
    if (!sessionId) throw new Error('session/new missing sessionId');
    await this.applySessionMode(sessionId, raw, opts.mode);
    return { sessionId, raw };
  }

  /**
   * Reopen a provider-persisted logical conversation in this new ACP process.
   * Unlike `session/new`, load accepts no system prompt: the harness restores
   * its own conversation and instructions instead of receiving transcript
   * text from Body again.
   */
  async sessionLoad(opts: {
    sessionId: string;
    cwd: string;
    mcpServers?: McpServerWire[];
    mode?: SessionMode;
  }): Promise<{ sessionId: string; raw: unknown }> {
    if (!this.supportsSessionLoading) {
      throw new Error('ACP agent does not advertise session/load');
    }
    const params: Record<string, unknown> = {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: (opts.mcpServers ?? []).map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? [],
      })),
    };
    const meta = sessionToolScopeMeta(this.agentLabel);
    if (meta) params._meta = meta;
    const result = await this.request('session/load', params);
    const raw = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    await this.applySessionMode(opts.sessionId, raw, opts.mode);
    return { sessionId: opts.sessionId, raw };
  }

  private async applySessionMode(
    sessionId: string,
    raw: Record<string, unknown>,
    mode: SessionMode | undefined,
  ): Promise<void> {
    if (!mode) return;
    const modes = raw.modes as
      | {
          availableModes?: Array<{ id?: string }>;
          currentModeId?: string;
        }
      | undefined;
    const candidates =
      mode === 'readonly'
        ? ['read-only', 'readonly']
        : cornerAutonomyModeCandidates(this.agentLabel);
    const target = modes?.availableModes?.find(
      (candidate) => candidate.id && candidates.includes(candidate.id),
    )?.id;
    if (!target || modes?.currentModeId === target) return;
    await this.request('session/set_mode', { sessionId, modeId: target });
  }

  /**
   * Run one prompt turn. `timeoutMs` is an idle window, not a hard cap on
   * turn length: every `session/update` for this session (message chunk,
   * tool call, or otherwise) re-arms it, so an actively-working agent can
   * run indefinitely while a genuinely wedged one (zero activity for
   * `timeoutMs`) still gets cancelled. `onChunk` is the ACP-boundary
   * streaming hook: called for every incremental `agent_message_chunk`
   * delta as it arrives, so a caller can project live text without waiting
   * for the turn to finish. A harness that only emits a final message
   * (never chunks) simply never invokes it — `agentText` is unaffected
   * either way. `onActivity`, when given, fires on every `session/update`
   * regardless of kind (the same trigger that re-arms the idle timer above),
   * so a caller can drive its own shorter "still working" notice off the
   * identical genuine-activity signal without duplicating the timeout logic.
   * It receives the current lane snapshot; existing callbacks that ignore
   * arguments remain valid.
   */
  async sessionPrompt(
    sessionId: string,
    text: string,
    timeoutMs = 120_000,
    onChunk?: AcpTextChunkHandler,
    onActivity?: AcpStreamHandler,
  ): Promise<PromptResult> {
    const updates: SessionUpdate[] = [];
    let promptRunId: string | undefined;
    let requestId: number | undefined;
    const onUpdate = (u: SessionUpdate) => {
      if (u.sessionId !== sessionId) return;
      updates.push(u);
      promptRunId ??= this.activeRunIdFromUpdate(u.update);
      if (requestId !== undefined) this.resetPendingIdleTimeout(requestId);
      onActivity?.(agentStreamSnapshot(updates, this.agentLabel));
      if (onChunk) {
        const delta = agentMessageChunkText(u.update);
        if (delta) onChunk(delta, joinAgentMessageChunks(updates, this.agentLabel));
      }
    };
    this.on('session/update', onUpdate);
    this.activePromptSessions.add(sessionId);

    try {
      const result = (await this.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text }],
        },
        timeoutMs,
        (id) => {
          requestId = id;
        },
      )) as { stopReason?: string };

      const agentText = finalAgentMessageText(updates, this.agentLabel);

      const toolCalls: ToolCallEntry[] = updates
        .filter((u) => {
          const s = u.update.sessionUpdate as string | undefined;
          return s === 'tool_call' || s === 'tool_call_update' || s === 'tool_result';
        })
        .map((u) => ({
          id: u.update.toolCallId as string | undefined,
          title: u.update.title as string | undefined,
          kind: u.update.kind as string | undefined,
          status: u.update.status as string | undefined,
        }));

      return {
        stopReason: result?.stopReason ?? 'end_turn',
        updates,
        agentText,
        toolCalls,
      };
    } finally {
      this.activePromptSessions.delete(sessionId);
      if (promptRunId && this.activeRunIds.get(sessionId) === promptRunId) {
        this.activeRunIds.delete(sessionId);
      }
      this.off('session/update', onUpdate);
    }
  }

  /**
   * Inject follow-up input into the prompt currently running for this session.
   * buzz-agent advertises the target run through ACP session metadata; binding
   * the request to that id prevents a late message from steering a newer turn.
   */
  async sessionSteer(sessionId: string, text: string, timeoutMs = 60_000): Promise<SteerResult> {
    if (this.supportsStandardSteering) {
      const raw = (await this.request(
        '_session/steering',
        {
          sessionId,
          prompt: [{ type: 'text', text }],
        },
        timeoutMs,
      )) as { outcome?: string };
      if (!raw.outcome || raw.outcome === 'failed') {
        throw new Error('ACP session steering failed');
      }
      return {
        runId: this.activeRunId(sessionId) ?? `session:${sessionId}`,
        messageId: raw.outcome,
      };
    }
    const expectedRunId = await this.waitForActiveRun(sessionId, Math.min(timeoutMs, 5_000));
    const raw = (await this.request(
      '_goose/unstable/session/steer',
      {
        sessionId,
        prompt: [{ type: 'text', text }],
        expectedRunId,
      },
      timeoutMs,
    )) as { runId?: string; messageId?: string };
    if (!raw.runId || !raw.messageId) {
      throw new Error('ACP session steer response missing runId or messageId');
    }
    return { runId: raw.runId, messageId: raw.messageId };
  }

  /** Active ACP run for a session, if the agent has advertised one. */
  activeRunId(sessionId: string): string | undefined {
    return (
      this.activeRunIds.get(sessionId) ??
      (this.activePromptSessions.has(sessionId) ? `session:${sessionId}` : undefined)
    );
  }

  sessionCancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  /**
   * The portable model/effort setter, confirmed round-tripping on pi/codex/
   * claude (report `data/buzzy-multiagent-runtimes/report.md` §3.2). The
   * param is `configId`, not `optionId` — `session/set_model` is NOT
   * portable and must not be used. Returns the runtime's updated
   * `configOptions`. Callers must validate `configId`/`value` against the
   * allow-listed catalog before calling this — see
   * `apps/body/src/model-config.ts`'s `assertModelConfigOptionAllowed`; this
   * method performs no policy checks of its own.
   */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    return this.request('session/set_config_option', { sessionId, configId, value });
  }

  private clearTimer(p: Pending): void {
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = undefined;
    }
  }

  /**
   * Re-arm a pending request's idle timer from its full `idleTimeoutMs`,
   * called on every ACP activity signal for that request (streamed text
   * delta, session/update, tool call). A request only times out after this
   * much wall-clock time with zero activity, not after a fixed deadline —
   * so an actively-working turn can run indefinitely while a genuinely
   * wedged one still gets caught.
   */
  private resetPendingIdleTimeout(id: number): void {
    const p = this.pending.get(id);
    if (!p || p.idleTimeoutMs === undefined) return;
    this.clearTimer(p);
    const { idleTimeoutMs, method, reject } = p;
    p.timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new AcpRequestTimeoutError(method ?? 'request', idleTimeoutMs, this.stderrTail, true));
    }, idleTimeoutMs);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const id = msg.id;
    const method = msg.method as string | undefined;

    // Response to our request.
    if (id !== undefined && !method) {
      const n = Number(id);
      const p = this.pending.get(n);
      if (!p) return;
      this.pending.delete(n);
      this.clearTimer(p);
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string };
        p.reject(new Error(`ACP error ${err.code}: ${err.message}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Agent → client request (has id + method).
    if (method && id !== undefined) {
      if (method === 'session/request_permission') {
        void this.handlePermission(id, msg.params);
        return;
      }
      // Unknown request — cancel/empty result.
      this.write({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    // Notifications (no id).
    if (method === 'session/update') {
      const params = msg.params as { sessionId?: string; update?: Record<string, unknown> };
      if (params?.sessionId && params.update) {
        // Harness-advertised slash commands/skills: captured here so the daemon
        // can republish them as the agent's durable command list (see
        // `agent-commands.ts` in buzz-client). Arrival is adapter-driven — all
        // shipped adapters push it at session start and on mid-session change.
        if (params.update.sessionUpdate === 'available_commands_update') {
          const commands = parseAvailableCommands(params.update.availableCommands);
          this.sessionCommands.set(params.sessionId, commands);
          this.emit('commands', { sessionId: params.sessionId, commands });
        }
        const toolCallId = params.update.toolCallId;
        const sessionUpdate = params.update.sessionUpdate;
        if (
          typeof toolCallId === 'string' &&
          (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
        ) {
          const metadataKey = `${params.sessionId}\0${toolCallId}`;
          const status = params.update.status;
          if (status === 'completed' || status === 'failed') {
            this.toolCallMetadata.delete(metadataKey);
          } else {
            const existing = this.toolCallMetadata.get(metadataKey);
            this.toolCallMetadata.set(metadataKey, {
              ...existing,
              toolCallId,
              ...(typeof params.update.title === 'string' ? { title: params.update.title } : {}),
              ...(typeof params.update.kind === 'string' ? { kind: params.update.kind } : {}),
              ...('rawInput' in params.update ? { rawInput: params.update.rawInput } : {}),
              // `content`/`locations` carry the touched file paths for adapters
              // whose permission request omits them (codex-acp's file-change
              // request has no rawInput at all) — the corner worktree guard in
              // `session-sandbox.ts` reads them.
              ...('content' in params.update ? { content: params.update.content } : {}),
              ...('locations' in params.update ? { locations: params.update.locations } : {}),
            });
          }
        }
        const u: SessionUpdate = {
          sessionId: params.sessionId,
          update: params.update,
        };
        const activeRunId = this.activeRunIdFromUpdate(params.update);
        if (activeRunId) this.activeRunIds.set(params.sessionId, activeRunId);
        this.emit('session/update', u);
      }
      return;
    }
  }

  private activeRunIdFromUpdate(update: Record<string, unknown>): string | undefined {
    const meta = update._meta as Record<string, unknown> | undefined;
    const goose = meta?.goose as Record<string, unknown> | undefined;
    return typeof goose?.activeRunId === 'string' && goose.activeRunId
      ? goose.activeRunId
      : undefined;
  }

  private waitForActiveRun(sessionId: string, timeoutMs: number): Promise<string> {
    const current = this.activeRunIds.get(sessionId);
    if (current) return Promise.resolve(current);

    return new Promise((resolve, reject) => {
      const onUpdate = (update: SessionUpdate) => {
        if (update.sessionId !== sessionId) return;
        const runId = this.activeRunIdFromUpdate(update.update);
        if (!runId) return;
        cleanup();
        resolve(runId);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`ACP session ${sessionId} has no active run to steer`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('session/update', onUpdate);
      };
      this.on('session/update', onUpdate);
    });
  }

  private async handlePermission(id: unknown, params: unknown): Promise<void> {
    const p = (params ?? {}) as AcpPermissionRequest;
    const toolCallId = p.toolCall?.toolCallId;
    const metadataKey = p.sessionId && toolCallId ? `${p.sessionId}\0${toolCallId}` : undefined;
    const tracked = metadataKey ? this.toolCallMetadata.get(metadataKey) : undefined;
    if (tracked) p.toolCall = { ...tracked, ...p.toolCall };
    let decision: AcpPermissionDecision = this.autoApprove ? 'allow' : 'reject';
    if (this.permissionHandler) {
      try {
        decision = await this.permissionHandler(p);
      } catch (error) {
        this.emit('permission/error', error);
        decision = 'reject';
      }
    }
    if (decision === 'allow') {
      const allow =
        p?.options?.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ??
        p?.options?.[0];
      if (allow?.optionId) {
        if (metadataKey) this.toolCallMetadata.delete(metadataKey);
        this.write({
          jsonrpc: '2.0',
          id,
          result: {
            outcome: { outcome: 'selected', optionId: allow.optionId },
          },
        });
        return;
      }
    }
    // Reject if we cannot approve.
    const reject = p?.options?.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
    if (reject?.optionId) {
      if (metadataKey) this.toolCallMetadata.delete(metadataKey);
      this.write({
        jsonrpc: '2.0',
        id,
        result: {
          outcome: { outcome: 'selected', optionId: reject.optionId },
        },
      });
      return;
    }
    if (metadataKey) this.toolCallMetadata.delete(metadataKey);
    this.write({
      jsonrpc: '2.0',
      id,
      result: { outcome: { outcome: 'cancelled' } },
    });
  }

  /**
   * `onStart`, when given, receives the assigned request id synchronously
   * and marks the request as idle-resettable at `timeoutMs`: callers can
   * then call `resetPendingIdleTimeout(id)` on activity to defer the
   * timeout instead of it firing at a fixed deadline.
   */
  private request(
    method: string,
    params: unknown,
    timeoutMs = 60_000,
    onStart?: (id: number) => void,
  ): Promise<unknown> {
    if (!this.child || !this.alive) {
      return Promise.reject(new Error('AcpClient not started'));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpRequestTimeoutError(method, timeoutMs, this.stderrTail, Boolean(onStart)));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        ...(onStart ? { idleTimeoutMs: timeoutMs } : {}),
      });
      onStart?.(id);
      this.write(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(obj: unknown): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }
}

export interface OpenAcpConversationOptions {
  client: AcpClient;
  /** Configured harness command, not a bwrap wrapper command. */
  agentCommand: string | undefined;
  /** In-memory logical conversation id retained across a clean suspension. */
  resumeSessionId?: string;
  cwd: string;
  mcpServers?: McpServerWire[];
  mode?: SessionMode;
  /** Lazily builds the bounded re-prime and creates a genuinely new session. */
  create(): Promise<{ sessionId: string; raw: unknown }>;
  onResumeFailure?(error: unknown): void;
}

export type OpenAcpConversationResult = {
  sessionId: string;
  raw: unknown;
  kind: 'resumed' | 'created';
};

/**
 * Prefer the harness's own persisted conversation on an in-process idle wake.
 * The `create` callback is deliberately lazy: reading durable transcript and
 * constructing `session-reprime.ts` output must happen only when no native
 * conversation exists (daemon restart, unsupported harness, or failed load).
 */
export async function openAcpConversation(
  options: OpenAcpConversationOptions,
): Promise<OpenAcpConversationResult> {
  if (
    options.resumeSessionId &&
    harnessSupportsNativeSessionResume(options.agentCommand) &&
    options.client.canLoadSession()
  ) {
    try {
      const resumed = await options.client.sessionLoad({
        sessionId: options.resumeSessionId,
        cwd: options.cwd,
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
      });
      return { ...resumed, kind: 'resumed' };
    } catch (error) {
      options.onResumeFailure?.(error);
    }
  }

  const created = await options.create();
  return { ...created, kind: 'created' };
}
