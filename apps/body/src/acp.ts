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

export interface AgentMessageChunk {
  type: 'text';
  text: string;
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

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class AcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private activeRunIds = new Map<string, string>();
  private activePromptSessions = new Set<string>();
  private supportsStandardSteering = false;
  private alive = false;
  private agentEnv: Record<string, string>;
  private agentCommand: string;
  private agentArgs: string[];
  private autoApprove: boolean;

  constructor(opts: {
    /** Legacy bare-binary option. Prefer agentCommand + agentArgs. */
    agentBinary?: string;
    agentCommand?: string;
    agentArgs?: string[];
    agentEnv: Record<string, string>;
    autoApprovePermissions?: boolean;
  }) {
    super();
    const command = opts.agentCommand ?? opts.agentBinary;
    if (!command) throw new Error('ACP agent command is required');
    this.agentCommand = command;
    this.agentArgs = [...(opts.agentArgs ?? [])];
    this.agentEnv = opts.agentEnv;
    this.autoApprove = opts.autoApprovePermissions ?? true;
  }

  async start(): Promise<void> {
    if (this.alive) return;
    this.child = spawn(this.agentCommand, this.agentArgs, {
      env: { ...process.env, ...this.agentEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.alive = true;

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.emit('stderr', chunk);
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));

    this.child.on('exit', (code, signal) => {
      this.alive = false;
      for (const [, p] of this.pending) {
        this.clearTimer(p);
        p.reject(
          new Error(`ACP agent ${this.agentCommand} exited code=${code} signal=${signal}`),
        );
      }
      this.pending.clear();
      this.activeRunIds.clear();
      this.activePromptSessions.clear();
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
  }

  get isAlive(): boolean {
    return this.alive;
  }

  async sessionNew(opts: {
    cwd: string;
    mcpServers?: McpServerWire[];
    systemPrompt?: string;
    /** Ask agents with ACP modes to enforce the Body session boundary. */
    mode?: 'readonly' | 'edit';
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
    mode: 'readonly' | 'edit' | undefined,
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

  async sessionPrompt(
    sessionId: string,
    text: string,
    timeoutMs = 120_000,
  ): Promise<PromptResult> {
    const updates: SessionUpdate[] = [];
    let promptRunId: string | undefined;
    const onUpdate = (u: SessionUpdate) => {
      if (u.sessionId !== sessionId) return;
      updates.push(u);
      promptRunId ??= this.activeRunIdFromUpdate(u.update);
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
      )) as { stopReason?: string };

      const agentText = updates
        .map((u) => {
          const up = u.update;
          // sessionUpdate can be "agent_message_chunk" or similar
          const sessionUpdate = up.sessionUpdate as string | undefined;
          if (sessionUpdate !== 'agent_message_chunk') return '';
          const content = up.content as { type?: string; text?: string } | undefined;
          if (content?.type === 'text') return content.text ?? '';
          // Also support direct content text
          if (typeof up.content === 'string') return up.content;
          return '';
        })
        .join('');

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
  async sessionSteer(
    sessionId: string,
    text: string,
    timeoutMs = 60_000,
  ): Promise<SteerResult> {
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

  private clearTimer(p: Pending): void {
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = undefined;
    }
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
    const p = params as {
      options?: Array<{ kind?: string; optionId?: string }>;
    };
    if (this.autoApprove) {
      const allow =
        p?.options?.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ??
        p?.options?.[0];
      if (allow?.optionId) {
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
      this.write({
        jsonrpc: '2.0',
        id,
        result: {
          outcome: { outcome: 'selected', optionId: reject.optionId },
        },
      });
      return;
    }
    this.write({
      jsonrpc: '2.0',
      id,
      result: { outcome: { outcome: 'cancelled' } },
    });
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    if (!this.child || !this.alive) {
      return Promise.reject(new Error('AcpClient not started'));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
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
