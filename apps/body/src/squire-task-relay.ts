/**
 * The helper owns Squire's MCP process for an agent's Room/DM/corner. ACP children
 * (including Pi's generated bridge) speak to this loopback relay instead of
 * spawning their own Squire server. Turns and ACP replacements share one
 * connection; each call still requires the current server-command authority.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { StdioSquireMcpClient } from './squire-mcp-client.js';
import { squireApprovalFromMcp } from './resource-mcp-facade.js';

type TurnKey = { roomId: string; requestId: string; taskId: string; generationId: string };
type RelayRequest = TurnKey & { method: string; params?: Record<string, unknown> };
export type SquireTaskCall = TurnKey & { tool: string; args: Record<string, unknown> };
/** Close an unused conversation connection after this bound. */
export const SQUIRE_TASK_IDLE_LEASE_MS = 15 * 60_000;

function sessionIds(value: unknown, depth = 0): string[] {
  if (depth > 8 || !value) return [];
  if (typeof value === 'string') {
    if (value.length > 100_000) return [];
    if (value.trimStart().startsWith('{')) {
      try { return sessionIds(JSON.parse(value), depth + 1); } catch { /* Squire may return prose. */ }
    }
    const labelled = value.match(/\b(?:browser[_ ]?)?session[_ ]?id\b[`"']?\s*[:=]\s*[`"']?([a-zA-Z0-9_-]{8,})/i);
    return labelled ? [labelled[1]!] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => sessionIds(entry, depth + 1));
  if (typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    /^(?:session_?id|browser_?session_?id)$/i.test(key) && typeof entry === 'string'
      ? [entry]
      : sessionIds(entry, depth + 1));
}

function redactedSessionId(id: string | undefined): string | null {
  return id ? createHash('sha256').update(id).digest('hex').slice(0, 16) : null;
}

function staleLeaseResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as { isError?: unknown; content?: unknown };
  if (result.isError !== true || !Array.isArray(result.content)) return false;
  const text = result.content.find((entry: unknown) =>
    entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'text',
  )?.text;
  if (!text) return false;
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown } };
    return body.error?.code === 'stale_lease';
  } catch { return false; }
}

function resultStatus(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || !value) return undefined;
  if (typeof value === 'string') {
    if (value.length > 100_000 || !value.trimStart().startsWith('{')) return undefined;
    try { return resultStatus(JSON.parse(value), depth + 1); } catch { return undefined; }
  }
  if (Array.isArray(value)) return value.map((item) => resultStatus(item, depth + 1)).find(Boolean);
  if (typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.status === 'string') return item.status;
  return Object.values(item).map((entry) => resultStatus(entry, depth + 1)).find(Boolean);
}

type PendingApproval = {
  requestId: string;
  sessionIds: Set<string>;
  tool: string;
  title: string;
  detail: string;
};

type TaskConnection = {
  taskId: string;
  lastRequestId: string;
  connectionId: string;
  client: StdioSquireMcpClient;
  sessions: Set<string>;
  pendingApprovals: Map<string, PendingApproval>;
  tools?: unknown;
  dead: boolean;
};

/** Squire's own decision on a pending approval, matched back to the turn that asked. */
export type SquireApprovalDecision = {
  readonly requestId: string;
  readonly approvalId: string;
  readonly status: 'approved' | 'denied';
  readonly tool: string;
  readonly title: string;
  readonly detail: string;
};

export class SquireTaskRelay {
  private server?: Server;
  private url?: string;
  private readonly token = randomUUID();
  private active?: TurnKey;
  private task?: TaskConnection;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private approvalRequestId?: string;
  private closed = false;
  private callTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly agentId: string,
    private readonly roomId: string,
    private readonly contextFile: string,
    private readonly authorize: (call: SquireTaskCall) => Promise<boolean>,
    home = homedir(),
    private readonly makeClient: (callbacks: {
      onSpawn: (pid: number | undefined) => void;
      onExit: (pid: number | undefined, code: number | null) => void;
      onDiagnostic: (message: string) => void;
      onNotification: (message: Record<string, unknown>) => void;
    }) => StdioSquireMcpClient = (callbacks) =>
      new StdioSquireMcpClient({ scope: { agentId, roomId }, home, processGroup: true,
        onSpawn: callbacks.onSpawn, onExit: callbacks.onExit, log: callbacks.onDiagnostic,
        onNotification: callbacks.onNotification }),
    /**
     * Squire's own decision on an approval this relay is still holding a
     * connection open for, relayed from the task connection's stdio session —
     * never polled. Defaults to a no-op so every existing caller (and test)
     * that does not pass one keeps working unchanged.
     */
    private readonly onApprovalDecided: (decision: SquireApprovalDecision) => void = () => {},
  ) {}

  async listen(): Promise<{ url: string; token: string; contextFile: string }> {
    if (this.closed) throw new Error('Squire task relay is closed');
    if (!this.server) {
      const server = createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/mcp' ||
            request.headers.authorization !== `Bearer ${this.token}`) {
          response.writeHead(403).end();
          return;
        }
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 2_000_000) throw new Error('Squire request too large');
          }
          const result = await this.handle(JSON.parse(body) as RelayRequest);
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }));
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' }).end(
            JSON.stringify({ error: error instanceof Error ? error.message : 'Squire relay failed' }),
          );
        }
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      this.server = server;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Squire relay has no TCP port');
      this.url = `http://127.0.0.1:${address.port}`;
    }
    return { url: this.url!, token: this.token, contextFile: this.contextFile };
  }

  activate(command: AgentCommand, generationId: string): void {
    if (command.agentId !== this.agentId || command.roomId !== this.roomId)
      throw new Error('Squire task scope does not match the server command');
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
    this.active = {
      roomId: command.roomId,
      requestId: command.turnRequestId,
      taskId: command.rootCommandId,
      generationId,
    };
    if (this.task) {
      this.task.taskId = command.rootCommandId;
      this.task.lastRequestId = command.turnRequestId;
    }
  }

  deactivate(requestId: string, approvalRequestId?: string): void {
    if (this.active?.requestId !== requestId) return;
    this.active = undefined;
    this.approvalRequestId = approvalRequestId;
    // A human approval is an open continuation, however long the card waits.
    if (approvalRequestId) return;
    this.scheduleIdle();
  }

  private scheduleIdle(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
    if (!this.task || this.approvalRequestId || this.task.pendingApprovals.size) return;
    const task = this.task;
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = undefined;
      if (!this.active && !this.approvalRequestId && !task.pendingApprovals.size &&
          this.task === task) this.retire('conversation-idle');
    }, SQUIRE_TASK_IDLE_LEASE_MS);
    this.leaseTimer.unref?.();
  }

  cancel(requestId: string): void {
    if (this.active?.requestId !== requestId && this.approvalRequestId !== requestId &&
        ![...(this.task?.pendingApprovals.values() ?? [])].some((approval) =>
          approval.requestId === requestId)) return;
    if (this.active?.requestId === requestId) this.active = undefined;
    if (this.approvalRequestId === requestId) this.approvalRequestId = undefined;
    for (const [id, approval] of this.task?.pendingApprovals ?? [])
      if (approval.requestId === requestId) this.task?.pendingApprovals.delete(id);
    if (!this.active && !this.approvalRequestId) this.scheduleIdle();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active = undefined;
    this.approvalRequestId = undefined;
    this.retire('helper-exit');
    this.server?.close();
  }

  private log(event: string, task: TaskConnection, extra: Record<string, unknown> = {}): void {
    const { sessionId, ...details } = extra;
    console.info('[squire-task]', JSON.stringify({
      event, agentId: this.agentId, conversationId: this.roomId, taskId: task.taskId,
      requestId: this.active?.requestId ?? task.lastRequestId,
      squireSessionId: sessionId ?? null,
      mcpConnectionId: task.connectionId,
      pid: extra.pid ?? task.client?.pid ?? null, ppid: process.pid,
      ...details,
    }));
  }

  private connection(taskId: string): TaskConnection {
    if (this.task) return this.task;
    const task = {
      taskId, lastRequestId: this.active?.requestId ?? '',
      connectionId: randomUUID(), sessions: new Set<string>(), pendingApprovals: new Map(), dead: false,
    } as TaskConnection;
    task.client = this.makeClient({
      onSpawn: (pid) => this.log('relay-spawn', task, { pid }),
      onNotification: (message) => this.handleApprovalNotification(task, message),
      onDiagnostic: (message) => {
        if (message.startsWith('squire mcp exited')) return;
        const reason = /broker unavailable/i.test(message) ? 'broker-unavailable'
          : /EADDRINUSE/.test(message) ? 'socket-in-use'
          : /ECONNREFUSED/.test(message) ? 'connection-refused'
          : /ENOENT/.test(message) ? 'path-missing'
          : 'mcp-stderr';
        this.log('relay-diagnostic', task, { reason });
      },
      onExit: (pid, code) => {
        task.dead = true;
        this.log('relay-exit', task, { pid, exitCode: code,
          sessionId: redactedSessionId(task.sessions.values().next().value) });
        task.sessions.clear();
        task.pendingApprovals.clear();
      },
    });
    this.task = task;
    return task;
  }

  private retire(reason: string): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
    if (!this.task) return;
    this.log('relay-close', this.task, { reason,
      sessionId: redactedSessionId(this.task.sessions.values().next().value) });
    this.task.client.close();
    this.task.sessions.clear();
    this.task.pendingApprovals.clear();
    this.task = undefined;
  }

  private handle(input: RelayRequest): Promise<unknown> {
    const next = this.callTail.then(() => this.handleSerial(input));
    this.callTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async handleSerial(input: RelayRequest): Promise<unknown> {
    const active = this.active;
    const inventory = input.method === 'initialize' || input.method === 'tools/list';
    const suppliedTurn = Object.keys(input).some((key) =>
      key === 'roomId' || key === 'requestId' || key === 'taskId' || key === 'generationId');
    if (this.closed || (!inventory && (!active || Object.keys(active).some((key) =>
      input[key as keyof TurnKey] !== active[key as keyof TurnKey]))) ||
      (inventory && active && suppliedTurn && Object.keys(active).some((key) =>
        input[key as keyof TurnKey] !== active[key as keyof TurnKey])))
      throw new Error('Squire requires the current active task');
    if (input.method === 'initialize') {
      const task = this.connection(active?.taskId ?? 'inventory');
      this.log('call-start', task, { method: input.method });
      this.log('call-end', task, { method: input.method });
      if (!active) this.scheduleIdle();
      return {
        protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'beeline-squire-task-relay', version: '1.0.0' },
      };
    }
    if (input.method !== 'tools/list' && input.method !== 'tools/call')
      throw new Error('Unsupported Squire MCP method');
    let task = this.connection(active?.taskId ?? 'inventory');
    const toolName = input.method === 'tools/call' ? input.params?.name : undefined;
    const safeToolName = typeof toolName === 'string' && /^[a-z][a-z0-9_]{0,80}$/i.test(toolName)
      ? toolName : undefined;
    const requestedIds = sessionIds(input.params?.arguments);
    this.log('call-start', task, { method: input.method, tool: safeToolName ?? null,
      sessionId: redactedSessionId(requestedIds[0] ?? task.sessions.values().next().value) });
    if (input.method === 'tools/list' && task.dead && task.tools) {
      this.log('call-end', task, { method: input.method, source: 'cached' });
      return task.tools;
    }
    if (input.method === 'tools/call' && task.dead && toolName !== 'operate_start') {
      this.log('call-refused', task, { reason: 'connection-died' });
      throw new Error('Squire MCP connection died and its browser session is gone; call operate_start');
    }
    if (input.method === 'tools/call' && (!safeToolName ||
        requestedIds.some((id) => !task.sessions.has(id)))) {
      this.log('call-refused', task, { reason: 'session-not-owned' });
      throw new Error('Squire browser session is no longer owned by this conversation; call operate_start');
    }
    if (input.method === 'tools/call' && !(await this.authorize({
      ...active!, tool: safeToolName!,
      args: input.params?.arguments && typeof input.params.arguments === 'object' &&
        !Array.isArray(input.params.arguments)
        ? input.params.arguments as Record<string, unknown> : {},
    }))) {
      this.log('call-refused', task, { reason: 'resource-denied' });
      throw new Error('Squire call is not authorized for this task');
    }
    if (task.dead) {
      if (toolName !== 'operate_start' || requestedIds.length) {
        this.log('call-refused', task, { reason: 'restart-required' });
        throw new Error('Squire MCP connection died; call operate_start for a fresh browser session');
      }
      this.retire('restart-required');
      task = this.connection(active!.taskId);
    }
    try {
      const result = await task.client.requestMcp(input.method, input.params ?? {});
      if (this.closed || this.task !== task || (active && (this.active?.taskId !== active.taskId ||
          this.active?.requestId !== active.requestId)))
        throw new Error('Squire task ended while the call was running');
      if (input.method === 'tools/list') task.tools = result;
      if (!active) this.scheduleIdle();
      if (staleLeaseResult(result)) {
        for (const id of requestedIds) task.sessions.delete(id);
        this.releasePendingApprovals(task, requestedIds);
        this.log('call-error', task, { method: input.method, tool: safeToolName ?? null,
          reason: 'stale-lease', sessionId: redactedSessionId(requestedIds[0]) });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'stale_lease', message: 'Squire browser session is gone; call operate_start for a fresh session' },
        }) }] };
      }
      if (safeToolName === 'operate_finish' &&
          !(result && typeof result === 'object' && (result as { isError?: unknown }).isError === true)) {
        for (const id of requestedIds) task.sessions.delete(id);
        this.releasePendingApprovals(task, requestedIds);
      } else {
        for (const id of sessionIds(result)) task.sessions.add(id);
      }
      const approval = input.method === 'tools/call' && squireApprovalFromMcp(
        { id: 1, method: input.method, params: input.params }, { id: 1, result },
      );
      if (approval) {
        const ids = requestedIds.length ? requestedIds : [...task.sessions];
        const approvalKey = createHash('sha256')
          .update(approval.approvalId ?? approval.approvalUrl).digest('hex');
        const status = resultStatus(result);
        // inject_card returns approval_pending; operate_drive wraps it as pending_approval.
        const pending = status === 'approval_pending' || status === 'pending_approval';
        if (pending && ids.length) {
          task.pendingApprovals.set(approvalKey, {
            requestId: active!.requestId, sessionIds: new Set(ids),
            tool: approval.tool, title: approval.title, detail: approval.detail,
          });
          this.log('approval-pending', task, { tool: safeToolName ?? null,
            sessionId: redactedSessionId(ids[0]) });
        } else if (!pending) {
          task.pendingApprovals.delete(approvalKey);
        }
      }
      this.log('call-end', task, { method: input.method, tool: safeToolName ?? null,
        sessionId: redactedSessionId(requestedIds[0] ?? sessionIds(result)[0] ?? task.sessions.values().next().value) });
      return result;
    } catch (error) {
      if (error instanceof Error && /timed out/.test(error.message)) {
        task.dead = true;
        task.sessions.clear();
        task.pendingApprovals.clear();
        task.client.close();
      }
      this.log('call-error', task, { method: input.method, tool: safeToolName ?? null,
        sessionId: redactedSessionId(requestedIds[0] ?? task.sessions.values().next().value) });
      if (task.dead)
        throw new Error('Squire MCP connection died and its browser session is gone; call operate_start');
      throw error;
    }
  }

  private releasePendingApprovals(task: TaskConnection, sessionIdsToRelease: string[]): void {
    for (const [id, approval] of task.pendingApprovals) {
      for (const sessionId of sessionIdsToRelease) approval.sessionIds.delete(sessionId);
      if (!approval.sessionIds.size) task.pendingApprovals.delete(id);
    }
  }

  /**
   * Squire's own unsolicited decision on an approval this task is still
   * holding a connection open for. Matched back to the pending entry by the
   * same hash `handleSerial` keyed it under (the approval id Squire itself
   * returned), so a notification for an approval this relay never tracked —
   * or one already released — is silently ignored, never trusted blind.
   */
  private handleApprovalNotification(task: TaskConnection, message: Record<string, unknown>): void {
    if (message.method !== 'notifications/approval_decided') return;
    const params = message.params as Record<string, unknown> | undefined;
    const approvalId = params?.approval_id;
    const status = params?.status;
    if (typeof approvalId !== 'string' || !approvalId ||
      (status !== 'approved' && status !== 'denied')) return;
    const approvalKey = createHash('sha256').update(approvalId).digest('hex');
    const pending = task.pendingApprovals.get(approvalKey);
    if (!pending) return;
    task.pendingApprovals.delete(approvalKey);
    this.onApprovalDecided({
      requestId: pending.requestId, approvalId, status,
      tool: pending.tool, title: pending.title, detail: pending.detail,
    });
    if (!this.active && !this.approvalRequestId && !task.pendingApprovals.size) this.scheduleIdle();
  }
}

/** Stdio MCP façade. It has no browser state; every request reaches the helper. */
export function runSquireTaskProxy(env: NodeJS.ProcessEnv = process.env): void {
  const url = env.BEELINE_SQUIRE_RELAY_URL;
  const token = env.BEELINE_SQUIRE_RELAY_TOKEN;
  const contextFile = env.BEELINE_TURN_CONTEXT_FILE;
  if (!url || !token || !contextFile) throw new Error('Squire task relay is unavailable');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    void (async () => {
      let input: { id?: string | number; method: string; params?: Record<string, unknown> };
      try { input = JSON.parse(line); } catch { return; }
      if (input.id === undefined) return;
      try {
        // Pi and other ACP clients enumerate tools before a server command is
        // claimed. Inventory is safe; calls still require the current turn file.
        const inventory = input.method === 'initialize' || input.method === 'tools/list';
        const context = inventory ? undefined : JSON.parse(await readFile(contextFile, 'utf8')) as TurnKey;
        const response = await fetch(new URL('/mcp', url), {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...context, method: input.method, params: input.params ?? {} }),
          signal: AbortSignal.timeout(120_000),
        });
        const body = await response.json() as { result?: unknown; error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Squire task relay refused the call');
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: input.id, result: body.result })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: input.id,
          error: { code: -32000, message: error instanceof Error ? error.message : 'Squire relay failed' } })}\n`);
      }
    })();
  });
}
