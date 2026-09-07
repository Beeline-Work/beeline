import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import {
  readRuntimeRecord,
  runtimeDirectory,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
} from './runtime.js';

type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];
type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];
export type InboxItem = Output<'getRoomInbox'>['items'][number];

export type DaemonFetch = typeof fetch;
export type DaemonWebSocketFactory = (url: string, protocols: string[]) => WebSocket;

export class DaemonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** The server's machine-readable refusal code, `request_failed` if none. */
    readonly code: string = 'request_failed',
  ) {
    super(message);
    this.name = 'DaemonApiError';
  }
}

/** The server's one settled answer that this agent no longer exists. */
export const AGENT_REMOVED_CODE = 'agent_removed';

/** Cursor maximum without treating the opaque message id as a number. */
export function laterInboxCursor(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftMatch = left.match(/^(\d+),([0-9a-f]{64})$/);
  const rightMatch = right.match(/^(\d+),([0-9a-f]{64})$/);
  // The cursor is contractually opaque to helpers. Keep accepting an older
  // server's alternate shape instead of making a rolling deploy fatal.
  if (!leftMatch || !rightMatch) return right;
  const timeOrder = BigInt(leftMatch[1]!) - BigInt(rightMatch[1]!);
  if (timeOrder !== 0n) return timeOrder > 0n ? left : right;
  return leftMatch[2]! >= rightMatch[2]! ? left : right;
}

/**
 * Whether the server has definitively said this agent was removed.
 *
 * Nothing else may stand in for it. A refused connection, a timeout, a 5xx,
 * an ordinary 401 from a token that could still be restored — every one of
 * those is uncertainty, and a helper that tore itself down on uncertainty
 * would delete a working runtime the first time the server hiccuped. Only a
 * 403 carrying `agent_removed`, which the server answers exactly when the
 * presented token is revoked AND its agent holds no live membership at all,
 * is proof.
 */
export function isAgentRemovedError(error: unknown): boolean {
  return (
    error instanceof DaemonApiError && error.status === 403 && error.code === AGENT_REMOVED_CODE
  );
}

function endpoint(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

async function responseError(response: Response): Promise<DaemonApiError> {
  let code = 'request_failed';
  try {
    const value = (await response.json()) as { error?: unknown };
    if (typeof value.error === 'string' && value.error) code = value.error;
  } catch {
    // Bodies are deliberately not reflected: they can contain operator data.
  }
  return new DaemonApiError(
    `monolith daemon request failed (${response.status}: ${code})`,
    response.status,
    response.status === 408 || response.status === 429 || response.status >= 500,
    code,
  );
}

/** Typed client for the complete named daemon operation contract. */
export class DaemonApiClient {
  private liveSocket?: WebSocket;
  private liveReconnect?: ReturnType<typeof setTimeout>;
  private liveReconnectDelayMs = 1_000;
  private readonly liveRooms = new Map<
    string,
    {
      cursor?: string;
      pushedIds: Set<string>;
      parityMissIds: Set<string>;
      parityReportedAt?: number;
      onItems?: (items: readonly InboxItem[], cursor?: string) => void;
    }
  >();
  private readonly parityPending = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  private readonly parityMisses = new Map<string, number>();

  constructor(
    readonly baseUrl: string,
    private readonly daemonToken: string,
    readonly agentId: string,
    private readonly fetchImpl: DaemonFetch = fetch,
    private readonly webSocketFactory: DaemonWebSocketFactory = (url, protocols) =>
      new WebSocket(url, protocols),
  ) {}

  /** Connection material for the daemon-owned MCP proxy and corner credentials. */
  connection(): { baseUrl: string; daemonToken: string; agentId: string } {
    return { baseUrl: this.baseUrl, daemonToken: this.daemonToken, agentId: this.agentId };
  }

  /** Add one Room to this agent's shared live socket. Polling remains active in Phase 2. */
  liveSubscribe(
    roomId: string,
    cursor?: string,
    onItems?: (items: readonly InboxItem[], cursor?: string) => void,
  ): () => void {
    const existing = this.liveRooms.get(roomId);
    if (existing) {
      existing.cursor = cursor ?? existing.cursor;
      existing.onItems = onItems ?? existing.onItems;
    } else {
      this.liveRooms.set(roomId, {
        ...(cursor ? { cursor } : {}),
        pushedIds: new Set(),
        parityMissIds: new Set(),
        ...(onItems ? { onItems } : {}),
      });
    }
    this.ensureLiveSocket();
    if (this.liveSocket?.readyState === WebSocket.OPEN) this.sendLiveSubscription(roomId);
    return () => {
      this.liveRooms.delete(roomId);
      const pending = this.parityPending.get(roomId);
      if (pending) for (const timer of pending.values()) clearTimeout(timer);
      this.parityPending.delete(roomId);
      if (this.liveSocket?.readyState === WebSocket.OPEN) {
        this.liveSocket.send(JSON.stringify({ type: 'unsubscribe', roomId }));
      }
      if (!this.liveRooms.size) {
        clearTimeout(this.liveReconnect);
        this.liveSocket?.close();
        this.liveSocket = undefined;
      }
    };
  }

  updateLiveCursor(roomId: string, cursor: string | undefined): void {
    const room = this.liveRooms.get(roomId);
    if (room && cursor) room.cursor = cursor;
  }

  /** Count a poll delivery only if push still has not produced its id after a grace window. */
  notePolled(roomId: string, items: readonly InboxItem[]): void {
    const room = this.liveRooms.get(roomId);
    if (!room) return;
    const now = Date.now();
    if (room.parityReportedAt === undefined || now - room.parityReportedAt >= 60_000) {
      room.parityReportedAt = now;
      console.info(`[thin-core] push parity room=${roomId} poll_only=${room.parityMissIds.size}`);
    }
    let pending = this.parityPending.get(roomId);
    if (!pending) {
      pending = new Map();
      this.parityPending.set(roomId, pending);
    }
    for (const item of items) {
      if (room.pushedIds.has(item.id) || pending.has(item.id)) continue;
      const timer = setTimeout(() => {
        pending!.delete(item.id);
        if (room.pushedIds.has(item.id) || room.parityMissIds.has(item.id)) return;
        room.parityMissIds.add(item.id);
        while (room.parityMissIds.size > 10_000)
          room.parityMissIds.delete(room.parityMissIds.values().next().value!);
        const count = room.parityMissIds.size;
        this.parityMisses.set(roomId, count);
        console.warn(`[thin-core] push parity miss room=${roomId} count=${count}`);
      }, 5_000);
      timer.unref?.();
      pending.set(item.id, timer);
    }
  }

  pushParityMissCount(roomId: string): number {
    return this.parityMisses.get(roomId) ?? 0;
  }

  async execute<Name extends keyof DaemonOperationMap>(
    name: Name,
    input: Input<Name>,
  ): Promise<Output<Name>> {
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.agentId === 'string' && candidate.agentId !== this.agentId) {
      throw new Error('daemon operation agentId does not match the runtime identity');
    }
    const response = await this.fetchImpl(
      endpoint(this.baseUrl, `/v1/daemon/operations/${String(name)}`),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.daemonToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as Output<Name>;
  }

  private ensureLiveSocket(): void {
    if (this.liveSocket || !this.liveRooms.size) return;
    const socket = this.webSocketFactory(
      this.baseUrl.replace(/^http/, 'ws') + '/v1/phone/live',
      [`bearer.${this.daemonToken}`],
    );
    this.liveSocket = socket;
    socket.onopen = () => {
      this.liveReconnectDelayMs = 1_000;
      for (const roomId of this.liveRooms.keys()) this.sendLiveSubscription(roomId);
    };
    socket.onmessage = (message) => {
      let value: unknown;
      try {
        value = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!value || typeof value !== 'object') return;
      const event = value as Record<string, unknown>;
      if (event.type !== 'inbox' || typeof event.roomId !== 'string' || !Array.isArray(event.items))
        return;
      const room = this.liveRooms.get(event.roomId);
      if (!room) return;
      const items: InboxItem[] = [];
      for (const candidate of event.items) {
        if (!candidate || typeof candidate !== 'object') continue;
        const id = (candidate as { id?: unknown }).id;
        if (typeof id === 'string') {
          if (!room.pushedIds.has(id)) items.push(candidate as InboxItem);
          room.pushedIds.add(id);
          if (room.parityMissIds.delete(id)) {
            this.parityMisses.set(event.roomId, room.parityMissIds.size);
            console.info(
              `[thin-core] push parity room=${event.roomId} poll_only=${room.parityMissIds.size}`,
            );
          }
          const pending = this.parityPending.get(event.roomId)?.get(id);
          if (pending) clearTimeout(pending);
          this.parityPending.get(event.roomId)?.delete(id);
        }
      }
      while (room.pushedIds.size > 10_000)
        room.pushedIds.delete(room.pushedIds.values().next().value!);
      if (items.length)
        room.onItems?.(items, typeof event.cursor === 'string' ? event.cursor : undefined);
    };
    const reconnect = () => {
      if (this.liveSocket !== socket) return;
      this.liveSocket = undefined;
      if (!this.liveRooms.size) return;
      const delay = this.liveReconnectDelayMs;
      this.liveReconnectDelayMs = Math.min(delay * 2, 30_000);
      this.liveReconnect = setTimeout(() => this.ensureLiveSocket(), delay);
      this.liveReconnect.unref?.();
    };
    socket.onerror = () => undefined;
    socket.onclose = reconnect;
  }

  private sendLiveSubscription(roomId: string): void {
    const room = this.liveRooms.get(roomId);
    if (!room || this.liveSocket?.readyState !== WebSocket.OPEN) return;
    this.liveSocket.send(
      JSON.stringify({
        type: 'subscribe',
        roomId,
        ...(room.cursor ? { cursor: room.cursor } : {}),
      }),
    );
  }
}

export interface ActivatedDaemonTransport {
  runtime: AgentRuntimeRecord;
  client: DaemonApiClient;
}

/**
 * Promote a staged one-use exchange token and persist the opaque daemon token
 * before any daemon operation runs. Re-entry with an already-promoted record
 * performs no exchange and is safe across daemon restarts.
 */
export async function activateDaemonTransport(
  path: string,
  fetchImpl: DaemonFetch = fetch,
): Promise<ActivatedDaemonTransport | undefined> {
  const runtime = await readRuntimeRecord(path);
  const expectedPath = resolve(
    runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey),
    'runtime.json',
  );
  if (resolve(path) !== expectedPath) {
    throw new Error(`refusing daemon token exchange outside canonical runtime path: ${path}`);
  }
  const transport = runtime.transport;
  if (!transport) return undefined;
  if ('daemonToken' in transport && transport.daemonToken) {
    return {
      runtime,
      client: new DaemonApiClient(
        transport.baseUrl,
        transport.daemonToken,
        runtime.agent.publicKey,
        fetchImpl,
      ),
    };
  }

  const response = await fetchImpl(endpoint(transport.baseUrl, '/v1/auth/daemon/exchange'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exchangeToken: transport.exchangeToken }),
  });
  if (!response.ok) throw await responseError(response);
  const result = (await response.json()) as { daemonToken?: unknown; agentId?: unknown };
  if (
    typeof result.daemonToken !== 'string' ||
    !/^bdt_[A-Za-z0-9_-]{43}$/.test(result.daemonToken) ||
    result.agentId !== runtime.agent.publicKey
  ) {
    throw new Error('daemon token exchange returned an invalid runtime identity');
  }
  const promoted: AgentRuntimeRecord = {
    ...runtime,
    transport: {
      kind: 'monolith',
      baseUrl: transport.baseUrl,
      daemonToken: result.daemonToken,
    },
  };
  await writeRuntimeRecord(promoted);
  return {
    runtime: promoted,
    client: new DaemonApiClient(
      transport.baseUrl,
      result.daemonToken,
      runtime.agent.publicKey,
      fetchImpl,
    ),
  };
}
