import {
  isAgentCommand,
  type AgentCommand,
  type DaemonOperationMap,
} from '@beeline/api-contract/daemon';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { helperVersion, helperVersionHeader } from './helper-version.js';
import { HostReadBudget, ReadBudgetFullError } from './host-read-budget.js';
import {
  readRuntimeRecord,
  runtimeDirectory,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
} from './runtime.js';

type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];
type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];
export type InboxItem = Output<'getRoomInbox'>['items'][number];

/** Membership / corner set change pushed on the daemon live socket. */
export type RoomMembershipChange = {
  readonly roomId?: string;
  readonly parentRoomId?: string;
  /** The corner's opener, carried by the same row that announces the corner. */
  readonly openedBy?: string;
  /** The named Room/corner is already archived, so nothing is started for it. */
  readonly archived?: boolean;
  readonly removed?: boolean;
  readonly repositoryChanged?: boolean;
};

export type DaemonFetch = typeof fetch;
export type DaemonWebSocketFactory = (url: string, protocols: string[]) => WebSocket;

export class DaemonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** The server's machine-readable refusal code, `request_failed` if none. */
    readonly code: string = 'request_failed',
    readonly retryAfterMs?: number,
    readonly minVersion?: string,
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

export function orderInboxItems(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((left, right) => {
    const leftMatch = left.cursor?.match(/^(\d+),([0-9a-f]{64})$/);
    const rightMatch = right.cursor?.match(/^(\d+),([0-9a-f]{64})$/);
    if (!leftMatch || !rightMatch) return 0;
    const timeOrder = BigInt(leftMatch[1]!) - BigInt(rightMatch[1]!);
    if (timeOrder !== 0n) return timeOrder < 0n ? -1 : 1;
    return leftMatch[2]! < rightMatch[2]! ? -1 : leftMatch[2]! > rightMatch[2]! ? 1 : 0;
  });
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

function membershipChange(event: Record<string, unknown>): RoomMembershipChange {
  return {
    ...(typeof event.roomId === 'string' && event.roomId ? { roomId: event.roomId } : {}),
    ...(typeof event.parentRoomId === 'string' ? { parentRoomId: event.parentRoomId } : {}),
    ...(typeof event.openedBy === 'string' ? { openedBy: event.openedBy } : {}),
    ...(event.archived === true ? { archived: true } : {}),
    ...(event.removed === true ? { removed: true } : {}),
    ...(event.repositoryChanged === true ? { repositoryChanged: true } : {}),
  };
}

function endpoint(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

async function responseError(response: Response): Promise<DaemonApiError> {
  let code = 'request_failed';
  let minVersion: string | undefined;
  try {
    const value = (await response.json()) as { error?: unknown; minVersion?: unknown };
    if (typeof value.error === 'string' && value.error) code = value.error;
    if (typeof value.minVersion === 'string') minVersion = value.minVersion;
  } catch {
    // Bodies are deliberately not reflected: they can contain operator data.
  }
  return new DaemonApiError(
    `monolith daemon request failed (${response.status}: ${code})`,
    response.status,
    response.status === 408 || response.status === 429 || response.status >= 500,
    code,
    retryAfterMs(response.headers.get('retry-after')),
    minVersion,
  );
}

/** Retry-After may be seconds or an HTTP date. Clamp malformed/remote values. */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 60_000) : undefined;
}

export type DaemonClientMetrics = {
  readonly inFlight: number;
  readonly requests: number;
  readonly timeouts: number;
  readonly reconnects: number;
  readonly subscriptionsSent: number;
  readonly readQueueDepth: number;
  readonly readQueueWaitMs: number;
};

const REQUEST_DEADLINE_MS = 30_000;
const STABLE_SOCKET_MS = 30_000;

/** Typed client for the complete named daemon operation contract. */
export class DaemonApiClient {
  private readonly presenceLifecycleId = randomUUID();
  private liveSocket?: WebSocket;
  private liveReconnect?: ReturnType<typeof setTimeout>;
  private liveReconnectDelayMs = 1_000;
  private liveOpenedAt = 0;
  private inFlight = 0;
  private requestCount = 0;
  private timeoutCount = 0;
  private reconnectCount = 0;
  private subscriptionCount = 0;
  private discoveryWakeSupported = false;
  private readonly readBudget?: HostReadBudget;
  private readonly liveRooms = new Map<
    string,
    {
      cursor?: string;
      pushedIds: Set<string>;
      pushedCommandIds: Set<string>;
      onItems?: (items: readonly InboxItem[], cursor?: string) => void;
      onState?: (
        connected: boolean,
        capabilities?: { pushIntake: boolean; connectionPresence: boolean },
      ) => void;
      onCommands?: (commands: readonly AgentCommand[]) => void;
      presence?: { releaseVersion?: string; sourceSha?: string; available?: boolean };
    }
  >();
  private roomsChangedListener?: (event?: RoomMembershipChange) => void;
  private memoryJobListener?: () => void;
  private configChangedListener?: () => void;
  private hiccupRestartListener?: (attempt: number) => void;
  private connectorAssignmentListener?: () => void;
  private cornerCompleteListener?: (roomId: string) => void;
  private cornerRestartListener?: (roomId: string) => void;
  private helperReleaseListener?: (release: { version: string; sha: string }) => void;
  private forceUpdateListener?: (minVersion: string) => void;
  private forceUpdatePending = false;
  private helperIdentity: { releaseVersion: string; sourceSha?: string } = {
    releaseVersion: 'v0.0.0',
  };

  constructor(
    readonly baseUrl: string,
    private readonly daemonToken: string,
    readonly agentId: string,
    private readonly fetchImpl: DaemonFetch = fetch,
    private readonly webSocketFactory: DaemonWebSocketFactory = (url, protocols) =>
      new WebSocket(url, protocols),
    readBudget?: HostReadBudget,
  ) {
    // Test transports may supply their own admission model. The real network
    // transport always takes the machine-wide budget.
    this.readBudget = readBudget ?? (fetchImpl === fetch ? new HostReadBudget(baseUrl) : undefined);
  }

  /** Connection material for the daemon-owned MCP proxy and corner credentials. */
  connection(): { baseUrl: string; daemonToken: string; agentId: string; helperVersion: string } {
    return { baseUrl: this.baseUrl, daemonToken: this.daemonToken, agentId: this.agentId,
      helperVersion: this.helperIdentity.releaseVersion };
  }

  setHelperIdentity(identity: { releaseVersion?: string; sourceSha?: string }): void {
    this.helperIdentity = {
      releaseVersion: helperVersion(identity.releaseVersion),
      ...(identity.sourceSha ? { sourceSha: identity.sourceSha } : {}),
    };
  }

  setForceUpdateListener(listener: (minVersion: string) => void): void {
    this.forceUpdateListener = listener;
  }

  metrics(): DaemonClientMetrics {
    const budget = this.readBudget?.metrics();
    return {
      inFlight: this.inFlight,
      requests: this.requestCount,
      timeouts: this.timeoutCount,
      reconnects: this.reconnectCount,
      subscriptionsSent: this.subscriptionCount,
      readQueueDepth: budget?.waiting ?? 0,
      readQueueWaitMs: budget?.totalWaitMs ?? 0,
    };
  }

  /** A new server can wake discovery after its DB listener recovers. */
  supportsDiscoveryWake(): boolean {
    return this.discoveryWakeSupported;
  }

  private requestForceUpdate(minVersion: string): void {
    if (this.forceUpdatePending) return;
    this.forceUpdatePending = true;
    clearTimeout(this.liveReconnect);
    this.liveReconnect = undefined;
    this.forceUpdateListener?.(minVersion);
    this.liveSocket?.close();
  }

  /** Add one Room to this agent's shared live socket. */
  liveSubscribe(
    roomId: string,
    cursor?: string,
    onItems?: (items: readonly InboxItem[], cursor?: string) => void,
    onState?: (
      connected: boolean,
      capabilities?: { pushIntake: boolean; connectionPresence: boolean },
    ) => void,
    presence?: { releaseVersion?: string; sourceSha?: string; available?: boolean },
    onCommands?: (commands: readonly AgentCommand[]) => void,
  ): () => void {
    const existing = this.liveRooms.get(roomId);
    if (existing) {
      existing.cursor = cursor ?? existing.cursor;
      existing.onItems = onItems ?? existing.onItems;
      existing.onState = onState ?? existing.onState;
      existing.presence = presence ?? existing.presence;
      existing.onCommands = onCommands ?? existing.onCommands;
    } else {
      this.liveRooms.set(roomId, {
        ...(cursor ? { cursor } : {}),
        pushedIds: new Set(),
        pushedCommandIds: new Set(),
        ...(onItems ? { onItems } : {}),
        ...(onState ? { onState } : {}),
        ...(presence ? { presence } : {}),
        ...(onCommands ? { onCommands } : {}),
      });
    }
    this.ensureLiveSocket();
    if (this.liveSocket?.readyState === WebSocket.OPEN) this.sendLiveSubscription(roomId);
    return () => {
      this.liveRooms.delete(roomId);
      if (this.liveSocket?.readyState === WebSocket.OPEN) {
        this.liveSocket.send(JSON.stringify({ type: 'unsubscribe', roomId }));
      }
      if (!this.liveRooms.size && !this.roomsChangedListener) {
        clearTimeout(this.liveReconnect);
        this.liveSocket?.close();
        this.liveSocket = undefined;
      }
    };
  }

  /** Register the one listener invoked when the server reports this agent's
   * Room/corner memberships changed — a scoped event applies incrementally;
   * an unscoped wake (reconnect) still runs the recovery reconcile. */
  setRoomsChangedListener(listener: (event?: RoomMembershipChange) => void): void {
    this.roomsChangedListener = listener;
    this.ensureLiveSocket();
  }

  /** A pending memory job is announced on the live socket. */
  setMemoryJobListener(listener: () => void): void {
    this.memoryJobListener = listener;
    this.ensureLiveSocket();
  }

  /** Register the one listener invoked when the server reports the agent's
   * model/effort selection changed — the wake that hot-restarts every
   * retained session (agent-wide; the event names no single Room). */
  setConfigChangedListener(listener: () => void): void {
    this.configChangedListener = listener;
  }

  /** systemd restart for a transient hiccup. Attempt is 1-indexed. */
  setHiccupRestartListener(listener: (attempt: number) => void): void {
    this.hiccupRestartListener = listener;
  }

  /** Connect / pending_ops drain wake. Never a catalog. */
  setConnectorAssignmentListener(listener: () => void): void {
    this.connectorAssignmentListener = listener;
  }

  /** corner-complete on the subscribed corner — close now, poll is recovery. */
  setCornerCompleteListener(listener: (roomId: string) => void): void {
    this.cornerCompleteListener = listener;
  }

  /** A no-code corner entered the code lane and must rebuild its local runtime. */
  setCornerRestartListener(listener: (roomId: string) => void): void {
    this.cornerRestartListener = listener;
  }

  setHelperReleaseListener(listener: (release: { version: string; sha: string }) => void): void {
    this.helperReleaseListener = listener;
  }

  updateLiveCursor(roomId: string, cursor: string | undefined): void {
    const room = this.liveRooms.get(roomId);
    if (room && cursor) room.cursor = cursor;
  }

  /** Retry an uncertain discovery read through socket reconnect backoff. */
  reconnectLive(): void {
    this.liveSocket?.close();
  }

  /** Release the long-lived socket when the helper itself is shutting down. */
  closeLive(): void {
    clearTimeout(this.liveReconnect);
    this.liveReconnect = undefined;
    const socket = this.liveSocket;
    this.liveSocket = undefined;
    socket?.close();
  }

  async execute<Name extends keyof DaemonOperationMap>(
    name: Name,
    input: Input<Name>,
  ): Promise<Output<Name>> {
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.agentId === 'string' && candidate.agentId !== this.agentId) {
      throw new Error('daemon operation agentId does not match the runtime identity');
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
    deadline.unref?.();
    this.requestCount += 1;
    let release: (() => Promise<void>) | undefined;
    let admitted = false;
    let output: Output<Name>;
    try {
      const operation = String(name);
      if (this.readBudget && (/^(get|list|read|search)/.test(operation) || operation === 'claimInstitutionalMemoryJob')) {
        release = await this.readBudget.acquire(
          operation === 'getAgentCommands' || operation === 'getRoomInbox' ? 'urgent' : 'background',
          Date.now() + REQUEST_DEADLINE_MS,
        );
      }
      this.inFlight += 1;
      admitted = true;
      const response = await this.fetchImpl(
        endpoint(this.baseUrl, `/v1/daemon/operations/${String(name)}`),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.daemonToken}`,
            'content-type': 'application/json',
            ...helperVersionHeader(this.helperIdentity.releaseVersion),
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const error = await responseError(response);
        if (error.status === 426 && error.code === 'update_required' && error.minVersion)
          this.requestForceUpdate(error.minVersion);
        throw error;
      }
      output = (await response.json()) as Output<Name>;
    } catch (error) {
      if (error instanceof ReadBudgetFullError) {
        throw new DaemonApiError(error.message, 429, true, 'read_budget_full', 1_000);
      }
      if (controller.signal.aborted) {
        this.timeoutCount += 1;
        throw new DaemonApiError(`monolith daemon ${String(name)} timed out`, 408, true, 'deadline_exceeded');
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      if (admitted) this.inFlight -= 1;
      await release?.();
    }
    if (name === 'postAgentTurnReceipt') {
      const receipt = output as { hiccupRestart?: unknown; hiccupAttempt?: unknown };
      if (receipt.hiccupRestart === true) {
        this.hiccupRestartListener?.(
          typeof receipt.hiccupAttempt === 'number' ? receipt.hiccupAttempt : 1,
        );
      }
    }
    return output;
  }

  private ensureLiveSocket(): void {
    if (this.forceUpdatePending || this.liveSocket || (!this.liveRooms.size && !this.roomsChangedListener)) return;
    const liveUrl = new URL('/v1/phone/live', this.baseUrl);
    liveUrl.protocol = liveUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    liveUrl.searchParams.set('helperVersion', this.helperIdentity.releaseVersion);
    if (this.helperIdentity.sourceSha) liveUrl.searchParams.set('sourceSha', this.helperIdentity.sourceSha);
    const socket = this.webSocketFactory(liveUrl.toString(), [
      `bearer.${this.daemonToken}`,
    ]);
    this.liveSocket = socket;
    socket.on?.('unexpected-response', (_request, response) => {
      if (response.statusCode !== 426) return;
      // A daemon opening after the minimum was raised is refused before any
      // WebSocket frame can arrive. Suppress reconnect while its short JSON
      // body supplies the same force-update signal as a live push.
      this.forceUpdatePending = true;
      clearTimeout(this.liveReconnect);
      this.liveReconnect = undefined;
      let body = '';
      response.on('data', (chunk: Buffer) => {
        if (body.length < 1024) body += chunk.toString('utf8').slice(0, 1024 - body.length);
      });
      response.on('end', () => {
        try {
          const refusal = JSON.parse(body) as { error?: unknown; minVersion?: unknown };
          if (refusal.error === 'update_required' && typeof refusal.minVersion === 'string')
            this.forceUpdateListener?.(refusal.minVersion);
        } catch {
          // A malformed refusal cannot authorize an install.
        }
      });
    });
    socket.onopen = () => {
      this.liveOpenedAt = Date.now();
      this.discoveryWakeSupported = false;
      for (const roomId of this.liveRooms.keys()) this.sendLiveSubscription(roomId);
      // Every wake on this socket is fire-and-forget: a membership written, or
      // a Connect tapped, while this socket was connecting (or between
      // reconnects) never replays its frame. Treat every open as both wakes, so
      // the reconciliation and the pending_ops drain still reach them.
      this.roomsChangedListener?.();
      this.connectorAssignmentListener?.();
      this.memoryJobListener?.();
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
      if (event.type === 'force-update' && typeof event.minVersion === 'string') {
        this.requestForceUpdate(event.minVersion);
        return;
      }
      if (event.type === 'hello' && event.protocolMin === 1 && event.protocolMax === 1) {
        const capabilities = event.capabilities as Record<string, unknown> | undefined;
        if (capabilities?.discoveryWake === true) this.discoveryWakeSupported = true;
        return;
      }
      if (event.type === 'helper-release' && typeof event.version === 'string' &&
          typeof event.sha === 'string') {
        this.helperReleaseListener?.({ version: event.version, sha: event.sha });
        return;
      }
      if (event.type === 'rooms-changed') {
        this.roomsChangedListener?.(membershipChange(event));
        return;
      }
      if (event.type === 'discovery-wake' &&
          (event.reason === 'listener-resync' || event.reason === 'database-recovered')) {
        this.roomsChangedListener?.();
        return;
      }
      if (event.type === 'corner-complete' && typeof event.roomId === 'string') {
        this.cornerCompleteListener?.(event.roomId);
        return;
      }
      if (event.type === 'corner-restart' && typeof event.roomId === 'string') {
        this.cornerRestartListener?.(event.roomId);
        return;
      }
      if (event.type === 'connector-assignment') {
        this.connectorAssignmentListener?.();
        return;
      }
      if (event.type === 'memory-job') {
        this.memoryJobListener?.();
        return;
      }
      if (event.type === 'config-changed') {
        this.configChangedListener?.();
        return;
      }
      if (event.type === 'hiccup-restart') {
        this.hiccupRestartListener?.(typeof event.attempt === 'number' ? event.attempt : 1);
        return;
      }
      if (event.type === 'subscribed' && typeof event.roomId === 'string') {
        const capabilities = event.capabilities as Record<string, unknown> | undefined;
        if (capabilities?.discoveryWake === true) this.discoveryWakeSupported = true;
        this.liveRooms.get(event.roomId)?.onState?.(true, {
          pushIntake: capabilities?.pushIntake === true,
          connectionPresence: capabilities?.connectionPresence === true,
        });
        return;
      }
      if (
        event.type === 'commands' &&
        typeof event.roomId === 'string' &&
        event.commandProtocol === 1 &&
        Array.isArray(event.commands)
      ) {
        const room = this.liveRooms.get(event.roomId);
        if (!room) return;
        const commands = event.commands.filter((command): command is AgentCommand => {
          if (
            !isAgentCommand(command) ||
            command.roomId !== event.roomId ||
            command.agentId !== this.agentId ||
            room.pushedCommandIds.has(command.id)
          )
            return false;
          room.pushedCommandIds.add(command.id);
          return true;
        });
        while (room.pushedCommandIds.size > 10_000)
          room.pushedCommandIds.delete(room.pushedCommandIds.values().next().value!);
        if (commands.length) room.onCommands?.(commands);
        return;
      }
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
      this.discoveryWakeSupported = false;
      for (const room of this.liveRooms.values()) room.onState?.(false);
      if (this.forceUpdatePending) return;
      if (!this.liveRooms.size && !this.roomsChangedListener) return;
      const delay = this.liveReconnectDelayMs;
      this.liveReconnectDelayMs = Date.now() - this.liveOpenedAt >= STABLE_SOCKET_MS
        ? 1_000
        : Math.min(delay * 2, 30_000);
      this.reconnectCount += 1;
      // Full jitter prevents a host's agents from reconnecting in lockstep.
      this.liveReconnect = setTimeout(() => this.ensureLiveSocket(), Math.floor(Math.random() * delay));
      this.liveReconnect.unref?.();
    };
    socket.onerror = () => undefined;
    socket.onclose = reconnect;
  }

  private sendLiveSubscription(roomId: string): void {
    const room = this.liveRooms.get(roomId);
    if (!room || this.liveSocket?.readyState !== WebSocket.OPEN) return;
    this.subscriptionCount += 1;
    this.liveSocket.send(
      JSON.stringify({
        type: 'subscribe',
        roomId,
        lifecycleId: this.presenceLifecycleId,
        ...(room.cursor ? { cursor: room.cursor } : {}),
        ...room.presence,
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
