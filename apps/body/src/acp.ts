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

/** Bound on the stderr tail kept for an exit-failure error message. */
const STDERR_TAIL_MAX_CHARS = 2_000;

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

/** Extract the text delta of an `agent_message_chunk` update, harness-agnostic. */
function agentMessageChunkText(update: Record<string, unknown>): string {
  if (update.sessionUpdate !== 'agent_message_chunk') return '';
  const content = update.content as { type?: string; text?: string } | undefined;
  if (content?.type === 'text') return content.text ?? '';
  if (typeof update.content === 'string') return update.content;
  return '';
}

/**
 * Concatenate every `agent_message_chunk` delta into one running text,
 * inserting a paragraph break wherever a text run resumes after one or more
 * intervening non-text updates (a tool call, a plan update, reasoning). A
 * harness's own deltas rarely carry a separating newline when narration
 * resumes after doing something else — the model treats it as a fresh
 * thought, not literally continued prose — so joining with nothing there
 * glues two distinct sentences together mid-word (e.g. "...patterns" +
 * "Now I have..." -> "...patternsNow I have..."). Consecutive deltas within
 * one uninterrupted text run are joined as-is: that is normal token
 * streaming and already carries its own whitespace.
 */
function joinAgentMessageChunks(updates: readonly SessionUpdate[]): string {
  let text = '';
  let lastWasText = false;
  for (const u of updates) {
    const delta = agentMessageChunkText(u.update);
    if (!delta) {
      lastWasText = false;
      continue;
    }
    if (!lastWasText && text && !/\s$/.test(text)) text += '\n\n';
    text += delta;
    lastWasText = true;
  }
  return text;
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
  private supportsStandardSteering = false;
  private alive = false;
  /** Bounded tail of recent stderr, so a spawn/exit failure's rejection text
   *  carries the real reason (e.g. a harness's own "missing API key" notice)
   *  instead of just the bare exit code — see `classifyAgentErrorState`. */
  private stderrTail = '';
  private agentEnv: Record<string, string>;
  private agentCommand: string;
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
    this.agentArgs = [...(opts.agentArgs ?? [])];
    this.agentEnv = opts.agentEnv;
    if (opts.agentCwd) this.agentCwd = opts.agentCwd;
    this.inheritProcessEnv =
      opts.inheritProcessEnv ?? process.env.BUZZY_BODY_AGENT_ENV_INHERIT === '1';
    this.autoApprove = opts.autoApprovePermissions ?? true;
    this.permissionHandler = opts.permissionHandler;
  }

  async start(): Promise<void> {
    if (this.alive) return;
    this.child = spawn(this.agentCommand, this.agentArgs, {
      // agentEnv is the child's whole environment: buildAgentEnv's allowlist is
      // a real boundary, not a decorative one layered over a full inherit.
      env: this.inheritProcessEnv ? { ...process.env, ...this.agentEnv } : this.agentEnv,
      ...(this.agentCwd ? { cwd: this.agentCwd } : {}),
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
            `ACP agent ${this.agentCommand} exited code=${code} signal=${signal}${stderrSuffix}`,
          ),
        );
      }
      this.pending.clear();
      this.activeRunIds.clear();
      this.activePromptSessions.clear();
      this.toolCallMetadata.clear();
      this.emit('exit', { code, signal });
    });

    this.child.on('error', (err) => {
      this.emit('error', err);
    });

    // ACP handshake: initialize, then send initialized notification.
    const initResult = (await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    })) as Record<string, unknown>;
    const initMeta = initResult._meta as Record<string, unknown> | undefined;
    const steering = initMeta?.steering as Record<string, unknown> | undefined;
    this.supportsStandardSteering = steering?.supported === true;
    this.emit('initialized', initResult);
    this.notify('notifications/initialized', {});
  }

  async stop(): Promise<void> {
    if (!this.alive) return;
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
      this.child?.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => setTimeout(r, 500));
    try {
      this.child?.kill('SIGKILL');
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

  async sessionNew(opts: {
    cwd: string;
    mcpServers?: McpServerWire[];
    systemPrompt?: string;
    /** Ask agents with ACP modes to enforce the Body session boundary. */
    mode?: SessionMode;
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
    const raw = (await this.request('session/new', params)) as Record<string, unknown>;
    const sessionId = raw.sessionId as string | undefined;
    if (!sessionId) throw new Error('session/new missing sessionId');
    await this.applySessionMode(sessionId, raw, opts.mode);
    return { sessionId, raw };
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
    const candidates = mode === 'readonly' ? ['read-only', 'readonly'] : ['agent', 'edit', 'code'];
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
   */
  async sessionPrompt(
    sessionId: string,
    text: string,
    timeoutMs = 120_000,
    onChunk?: AcpTextChunkHandler,
    onActivity?: () => void,
  ): Promise<PromptResult> {
    const updates: SessionUpdate[] = [];
    let promptRunId: string | undefined;
    let requestId: number | undefined;
    const onUpdate = (u: SessionUpdate) => {
      if (u.sessionId !== sessionId) return;
      updates.push(u);
      promptRunId ??= this.activeRunIdFromUpdate(u.update);
      if (requestId !== undefined) this.resetPendingIdleTimeout(requestId);
      onActivity?.();
      if (onChunk) {
        const delta = agentMessageChunkText(u.update);
        if (delta) onChunk(delta, joinAgentMessageChunks(updates));
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

      const agentText = joinAgentMessageChunks(updates);

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
      reject(new Error(`ACP ${method} timed out after ${idleTimeoutMs}ms of inactivity`));
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
    const suffix = onStart ? ' of inactivity' : '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms${suffix}`));
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
