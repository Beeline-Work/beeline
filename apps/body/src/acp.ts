/**
 * Minimal ACP client over stdio for buzz-agent.
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
 * therefore drives buzz-agent directly so mode = MCP mount is a hard boundary
 * and multi-user activity projection is possible.
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
  private alive = false;
  private agentEnv: Record<string, string>;
  private agentBinary: string;
  private autoApprove: boolean;

  constructor(opts: {
    agentBinary: string;
    agentEnv: Record<string, string>;
    autoApprovePermissions?: boolean;
  }) {
    super();
    this.agentBinary = opts.agentBinary;
    this.agentEnv = opts.agentEnv;
    this.autoApprove = opts.autoApprovePermissions ?? true;
  }

  async start(): Promise<void> {
    if (this.alive) return;
    this.child = spawn(this.agentBinary, [], {
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
        p.reject(new Error(`buzz-agent exited code=${code} signal=${signal}`));
      }
      this.pending.clear();
      this.emit('exit', { code, signal });
    });

    this.child.on('error', (err) => {
      this.emit('error', err);
    });

    // ACP handshake: initialize, then send initialized notification.
    const initResult = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
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
  }

  get isAlive(): boolean {
    return this.alive;
  }

  async sessionNew(opts: {
    cwd: string;
    mcpServers?: McpServerWire[];
    systemPrompt?: string;
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
    return { sessionId, raw };
  }

  async sessionPrompt(
    sessionId: string,
    text: string,
    timeoutMs = 120_000,
  ): Promise<PromptResult> {
    const updates: SessionUpdate[] = [];
    const onUpdate = (u: SessionUpdate) => {
      if (u.sessionId === sessionId) updates.push(u);
    };
    this.on('session/update', onUpdate);

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
      this.off('session/update', onUpdate);
    }
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
        this.emit('session/update', u);
      }
      return;
    }
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