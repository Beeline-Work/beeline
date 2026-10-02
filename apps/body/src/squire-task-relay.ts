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
import {
  SQUIRE_SESSION_STALE_MS,
  SquireSessionRegistry,
  squireOrderIdentity,
} from './squire-session-registry.js';
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

type TaskConnection = {
  taskId: string;
  lastRequestId: string;
  connectionId: string;
  client: StdioSquireMcpClient;
  sessions: Set<string>;
  pendingApprovals: Map<string, { requestId: string; sessionIds: Set<string> }>;
  tools?: unknown;
  dead: boolean;
};

export type SquireTaskRelayOptions = {
  /** Host-shared registry of open sessions and staged-order locks. */
  registry?: SquireSessionRegistry;
  /** The human that paired this agent (`runtime.pairedBy`), when known. */
  ownerId?: string | null;
  /** How long a session whose turn ended survives before it is reaped. */
  sessionStaleMs?: number;
};

export class SquireTaskRelay {
  private server?: Server;
  private url?: string;
  private readonly token = randomUUID();
  private readonly closeToken = randomUUID();
  private readonly relayId = randomUUID();
  private readonly registry?: SquireSessionRegistry;
  private readonly ownerId: string | null;
  private readonly sessionStaleMs: number;
  private active?: TurnKey;
  private task?: TaskConnection;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private reapTimer?: ReturnType<typeof setTimeout>;
  private approvalRequestId?: string;
  private closed = false;
  private callTail: Promise<void> = Promise.resolve();
  /** orderKey → display label for an order this relay is staging. */
  private readonly orderLocks = new Map<string, string>();
  /** approvalKey → orderKey, so an approval's end releases its order lock. */
  private readonly approvalOrderKeys = new Map<string, string>();
  /** raw approval id → orderKey, so the call that resolves the approval releases it. */
  private readonly approvalIdOrderKeys = new Map<string, string>();

  constructor(
    private readonly agentId: string,
    private readonly roomId: string,
    private readonly contextFile: string,
    private readonly authorize: (call: SquireTaskCall) => Promise<boolean>,
    home = homedir(),
    private readonly makeClient: (callbacks: {
      onSpawn: (pid: number | undefined) => void;
      onExit: (pid: number | undefined, code: number | null) => void;
    }) => StdioSquireMcpClient = (callbacks) =>
      new StdioSquireMcpClient({ scope: { agentId, roomId }, home, processGroup: true, ...callbacks }),
    options: SquireTaskRelayOptions = {},
  ) {
    this.registry = options.registry;
    this.ownerId = options.ownerId ?? null;
    this.sessionStaleMs = options.sessionStaleMs ?? SQUIRE_SESSION_STALE_MS;
  }

  async listen(): Promise<{ url: string; token: string; contextFile: string }> {
    if (this.closed) throw new Error('Squire task relay is closed');
    if (!this.server) {
      const server = createServer(async (request, response) => {
        if (request.method === 'POST' && request.url === '/sessions/close') {
          if (request.headers.authorization !== `Bearer ${this.closeToken}`) {
            response.writeHead(403).end();
            return;
          }
          try {
            let body = '';
            for await (const chunk of request) body += chunk;
            const input = JSON.parse(body) as { sessionId?: unknown; ownerId?: unknown };
            await this.closeStaleSession(
              String(input.sessionId ?? ''),
              typeof input.ownerId === 'string' && input.ownerId ? input.ownerId : null,
            );
            response.writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ closed: true }));
          } catch (error) {
            response.writeHead(409, { 'content-type': 'application/json' }).end(
              JSON.stringify({ error: error instanceof Error ? error.message : 'close refused' }),
            );
          }
          return;
        }
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
    this.clearReap();
    if (this.task) {
      this.task.taskId = command.rootCommandId;
      this.task.lastRequestId = command.turnRequestId;
    }
    this.publishSessions();
  }

  deactivate(requestId: string, approvalRequestId?: string): void {
    if (this.active?.requestId !== requestId) return;
    this.active = undefined;
    this.approvalRequestId = approvalRequestId;
    this.publishSessions();
    this.scheduleReap();
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
    for (const [id, approval] of [...(this.task?.pendingApprovals ?? [])]) {
      if (approval.requestId !== requestId) continue;
      this.task?.pendingApprovals.delete(id);
      this.releaseApprovalOrderLock(id);
    }
    this.publishSessions();
    if (!this.active && !this.approvalRequestId) {
      this.scheduleIdle();
      this.scheduleReap();
    }
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
      onExit: (pid, code) => {
        task.dead = true;
        this.log('relay-exit', task, { pid, exitCode: code,
          sessionId: redactedSessionId(task.sessions.values().next().value) });
        task.sessions.clear();
        task.pendingApprovals.clear();
        this.registry?.removeRelaySessions(this.relayId);
        this.releaseAllOrderLocks();
      },
    });
    this.task = task;
    return task;
  }

  private retire(reason: string): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
    this.clearReap();
    if (!this.task) return;
    this.log('relay-close', this.task, { reason,
      sessionId: redactedSessionId(this.task.sessions.values().next().value) });
    this.task.client.close();
    this.registry?.removeRelaySessions(this.relayId);
    this.releaseAllOrderLocks();
    this.task.sessions.clear();
    this.task.pendingApprovals.clear();
    this.task = undefined;
  }

  /** Publish every session this relay holds with the liveness its turn just set. */
  private publishSessions(): void {
    if (!this.registry || !this.task) return;
    const live = Boolean(this.active);
    for (const sessionId of this.task.sessions)
      this.registry.setSessionLive(sessionId, live, this.sessionHasPendingApproval(sessionId));
  }

  private sessionHasPendingApproval(sessionId: string): boolean {
    for (const approval of this.task?.pendingApprovals.values() ?? [])
      if (approval.sessionIds.has(sessionId)) return true;
    return false;
  }

  private addSessions(task: TaskConnection, ids: string[]): void {
    for (const id of ids) {
      if (task.sessions.has(id)) continue;
      task.sessions.add(id);
      const startedAt = Date.now();
      this.registry?.registerSession({
        sessionId: id,
        ownerAgentId: this.agentId,
        ownerId: this.ownerId,
        conversationId: this.roomId,
        relayId: this.relayId,
        pid: process.pid,
        startedAt,
        turnLive: Boolean(this.active),
        approvalPending: false,
        updatedAt: startedAt,
        closeUrl: this.url ?? '',
        closeToken: this.closeToken,
      });
    }
  }

  private dropSessions(task: TaskConnection, ids: string[]): void {
    for (const id of ids) {
      task.sessions.delete(id);
      this.registry?.removeSession(id);
    }
  }

  /**
   * A session whose turn ended is reaped after `sessionStaleMs` unless a human
   * approval still holds it. That is the bound which stops an abandoned browser
   * from blocking every other agent's `operate_start` on the shared broker.
   */
  private scheduleReap(): void {
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.reapTimer = undefined;
    if (!this.registry || !this.task || this.closed) return;
    const task = this.task;
    this.reapTimer = setTimeout(() => {
      this.reapTimer = undefined;
      if (this.active || this.closed || this.task !== task) return;
      for (const sessionId of [...task.sessions]) {
        if (this.sessionHasPendingApproval(sessionId)) continue;
        void this.reapSession(task, sessionId, 'stale-timeout').catch(() => {});
      }
    }, this.sessionStaleMs);
    this.reapTimer.unref?.();
  }

  private clearReap(): void {
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.reapTimer = undefined;
  }

  /**
   * Close a Squire browser session this relay owns, refusing while a turn holds
   * it: a live session is never closable from outside, which is the guarantee
   * the shared broker needs. Only an agent of the same owner may ask.
   */
  private async closeStaleSession(sessionId: string, requesterOwnerId: string | null): Promise<void> {
    if (!sessionId) throw new Error('a Squire session id is required');
    if (this.ownerId && requesterOwnerId !== this.ownerId)
      throw new Error('Squire sessions may only be closed by an agent of the same owner');
    const task = this.task;
    if (!task || !task.sessions.has(sessionId))
      throw new Error('Squire session is not owned by this helper');
    if (this.active) throw new Error('Squire session is in use by a live turn');
    if (this.sessionHasPendingApproval(sessionId))
      throw new Error('Squire session has an approval awaiting a human decision');
    await this.reapSession(task, sessionId, 'closed-by-owner-agent');
  }

  private async reapSession(task: TaskConnection, sessionId: string, reason: string): Promise<void> {
    if (task !== this.task || !task.sessions.has(sessionId)) return;
    // Squire's own tool takes `session_id` (snake_case); a camelCase argument
    // would be rejected and the browser would stay open behind a "closed"
    // record. A refused close keeps the record so it can be retried instead of
    // pretending the shared browser was freed.
    let closed: unknown;
    try {
      closed = await task.client.requestMcp('tools/call', {
        name: 'operate_finish', arguments: { session_id: sessionId },
      });
    } catch (error) {
      this.log('session-reap-failed', task, { reason, sessionId: redactedSessionId(sessionId) });
      throw error;
    }
    if (closed && typeof closed === 'object' && (closed as { isError?: unknown }).isError === true) {
      this.log('session-reap-failed', task, { reason, sessionId: redactedSessionId(sessionId) });
      throw new Error('Squire refused to close the session; it is still open');
    }
    task.sessions.delete(sessionId);
    this.releasePendingApprovals(task, [sessionId]);
    this.registry?.removeSession(sessionId);
    this.log('session-reaped', task, { reason, sessionId: redactedSessionId(sessionId) });
  }

  /**
   * A staged order takes a host-wide lock before its card release reaches
   * Squire, so a second agent of the same owner staging the same order is
   * refused instead of opening a second live card-release link.
   */
  private acquireOrderLock(task: TaskConnection, tool: string, args: Record<string, unknown>): void {
    const identity = squireOrderIdentity(tool, args);
    if (!identity || !this.registry || this.orderLocks.has(identity.orderKey)) return;
    const held = this.registry.acquireOrderLock({
      orderKey: identity.orderKey,
      label: identity.label,
      holderAgentId: this.agentId,
      holderOwnerId: this.ownerId,
      conversationId: this.roomId,
      relayId: this.relayId,
      pid: process.pid,
      acquiredAt: Date.now(),
      approvalPending: false,
    });
    if (!held.acquired) {
      this.log('order-refused', task, { reason: 'order-locked' });
      throw new Error(
        `Another agent of your owner is already staging this order (${held.heldBy.label}); ` +
        'wait for that agent to finish or ask it to release the order.',
      );
    }
    this.orderLocks.set(identity.orderKey, identity.label);
  }

  private releaseApprovalOrderLock(approvalKey: string): void {
    const orderKey = this.approvalOrderKeys.get(approvalKey);
    if (!orderKey) return;
    this.approvalOrderKeys.delete(approvalKey);
    this.releaseOrderLock(orderKey);
  }

  private releaseOrderLock(orderKey: string): void {
    for (const [approvalId, key] of [...this.approvalIdOrderKeys])
      if (key === orderKey) this.approvalIdOrderKeys.delete(approvalId);
    if (!this.orderLocks.delete(orderKey)) return;
    this.registry?.releaseOrderLock(orderKey, this.relayId);
  }

  private releaseAllOrderLocks(): void {
    for (const orderKey of [...this.orderLocks.keys()]) this.releaseOrderLock(orderKey);
  }

  private handle(input: RelayRequest): Promise<unknown> {
    const next = this.callTail.then(() => this.handleSerial(input));
    this.callTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async handleSerial(input: RelayRequest): Promise<unknown> {
    const active = this.active;
    if (!active || this.closed || Object.keys(active).some((key) =>
      input[key as keyof TurnKey] !== active[key as keyof TurnKey]))
      throw new Error('Squire requires the current active task');
    if (input.method === 'initialize') {
      const task = this.connection(active.taskId);
      this.log('call-start', task, { method: input.method });
      this.log('call-end', task, { method: input.method });
      return {
        protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'beeline-squire-task-relay', version: '1.0.0' },
      };
    }
    if (input.method !== 'tools/list' && input.method !== 'tools/call')
      throw new Error('Unsupported Squire MCP method');
    let task = this.connection(active.taskId);
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
    const callArgs = input.params?.arguments && typeof input.params.arguments === 'object' &&
      !Array.isArray(input.params.arguments)
      ? input.params.arguments as Record<string, unknown> : {};
    if (input.method === 'tools/call' && !(await this.authorize({
      ...active, tool: safeToolName!, args: callArgs,
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
      task = this.connection(active.taskId);
    }
    const orderIdentity = input.method === 'tools/call' && safeToolName
      ? squireOrderIdentity(safeToolName, callArgs)
      : undefined;
    if (orderIdentity) this.acquireOrderLock(task, safeToolName!, callArgs);
    let orderLockHeld = false;
    try {
      const result = await task.client.requestMcp(input.method, input.params ?? {});
      if (this.closed || this.task !== task || this.active?.taskId !== active.taskId ||
          this.active?.requestId !== active.requestId)
        throw new Error('Squire task ended while the call was running');
      if (input.method === 'tools/list') task.tools = result;
      if (staleLeaseResult(result)) {
        this.dropSessions(task, requestedIds);
        this.releasePendingApprovals(task, requestedIds);
        this.log('call-error', task, { method: input.method, tool: safeToolName ?? null,
          reason: 'stale-lease', sessionId: redactedSessionId(requestedIds[0]) });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'stale_lease', message: 'Squire browser session is gone; call operate_start for a fresh session' },
        }) }] };
      }
      if (safeToolName === 'operate_finish' &&
          !(result && typeof result === 'object' && (result as { isError?: unknown }).isError === true)) {
        this.dropSessions(task, requestedIds);
        this.releasePendingApprovals(task, requestedIds);
      } else {
        this.addSessions(task, sessionIds(result));
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
            requestId: active.requestId, sessionIds: new Set(ids),
          });
          if (orderIdentity) {
            this.approvalOrderKeys.set(approvalKey, orderIdentity.orderKey);
            if (approval.approvalId)
              this.approvalIdOrderKeys.set(approval.approvalId, orderIdentity.orderKey);
            this.registry?.setOrderLockApprovalPending(orderIdentity.orderKey, true);
            orderLockHeld = true;
          }
          this.log('approval-pending', task, { tool: safeToolName ?? null,
            sessionId: redactedSessionId(ids[0]) });
        } else if (!pending) {
          task.pendingApprovals.delete(approvalKey);
          this.releaseApprovalOrderLock(approvalKey);
        }
        this.publishSessions();
      }
      // The call that consumes an approval often carries no order facts at all
      // (only `approval_id`), so resolve the lock from the approval id itself.
      const callApprovalId = typeof callArgs.approval_id === 'string' ? callArgs.approval_id : undefined;
      if (callApprovalId) {
        const status = resultStatus(result);
        const stillPending = status === 'approval_pending' || status === 'pending_approval';
        const orderKey = this.approvalIdOrderKeys.get(callApprovalId);
        if (!stillPending && orderKey) {
          this.approvalIdOrderKeys.delete(callApprovalId);
          this.releaseOrderLock(orderKey);
          orderLockHeld = false;
        }
      }
      if (orderIdentity && !orderLockHeld) this.releaseOrderLock(orderIdentity.orderKey);
      this.log('call-end', task, { method: input.method, tool: safeToolName ?? null,
        sessionId: redactedSessionId(requestedIds[0] ?? sessionIds(result)[0] ?? task.sessions.values().next().value) });
      return result;
    } catch (error) {
      if (orderIdentity && !orderLockHeld) this.releaseOrderLock(orderIdentity.orderKey);
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
      if (!approval.sessionIds.size) {
        task.pendingApprovals.delete(id);
        this.releaseApprovalOrderLock(id);
      }
    }
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
        const context = JSON.parse(await readFile(contextFile, 'utf8')) as TurnKey;
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
