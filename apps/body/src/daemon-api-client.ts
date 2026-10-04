import {
  isAgentCommand,
  type AgentCommand,
  type AgentSignInFrame,
  type DaemonOperationMap,
} from '@beeline/api-contract/daemon';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { helperVersion, helperVersionHeader } from './helper-version.js';
import { HostReadBudget, ReadBudgetFullError } from './host-read-budget.js';
import {
  isNetworkFailure,
  retryAfterMs,
  type LiveLink,
  type LiveLinkTiming,
  type LiveSocketFactory,
} from './live-link.js';
import { MachineLink, type AgentChannel } from './machine-link.js';
import { agentSignInFrame } from './agent-sign-in.js';
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
export type DaemonWebSocketFactory = LiveSocketFactory;

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

/** Typed client for the complete named daemon operation contract. */
export class DaemonApiClient {
  private readonly presenceLifecycleId = randomUUID();
  /** This agent's registration on the machine's one live socket. */
  readonly channel: AgentChannel;
  readonly machine: MachineLink;
  private inFlight = 0;
  private requestCount = 0;
  private timeoutCount = 0;
  private subscriptionCount = 0;
  private readonly readBudget?: HostReadBudget;
  private readonly liveRooms = new Map<
    string,
    {
      cursor?: string;
      pushedIds: Set<string>;
      registrations: Set<{
        onItems?: (items: readonly InboxItem[], cursor?: string) => void;
        onState?: (
          connected: boolean,
          capabilities?: { pushIntake: boolean; connectionPresence: boolean },
        ) => void;
        onCommands?: (commands: readonly AgentCommand[]) => void;
        presence?: { releaseVersion?: string; sourceSha?: string; available?: boolean };
      }>;
    }
  >();
  private roomsChangedListener?: (event?: RoomMembershipChange) => void;
  private configChangedListener?: () => void;
  private connectorAssignmentListener?: () => void;
  private agentSignInListener?: (frame: AgentSignInFrame) => void;
  private cornerCompleteListener?: (roomId: string) => void;
  private cornerRestartListener?: (roomId: string) => void;
  private helperReleaseListener?: (release: { version: string; sha: string }) => void;
  private forceUpdateListener?: (minVersion: string) => void;
  private helperIdentity: { releaseVersion: string; sourceSha?: string } = {
    releaseVersion: 'v0.0.0',
  };

  constructor(
    readonly baseUrl: string,
    private readonly daemonToken: string,
    readonly agentId: string,
    private readonly fetchImpl: DaemonFetch = fetch,
    webSocketFactory?: DaemonWebSocketFactory,
    readBudget?: HostReadBudget,
    linkTiming?: Partial<LiveLinkTiming>,
    /** The process's shared machine socket; a standalone client opens its own. */
    machine?: MachineLink,
  ) {
    // Test transports may supply their own admission model. The real network
    // transport always takes the machine-wide budget.
    this.readBudget = readBudget ?? (fetchImpl === fetch ? new HostReadBudget(baseUrl) : undefined);
    this.machine = machine ?? new MachineLink({
      baseUrl,
      ...(webSocketFactory ? { factory: webSocketFactory } : {}),
      ...(linkTiming ? { timing: linkTiming } : {}),
    });
    this.channel = this.machine.attach(agentId, {
      registration: () => ({
        token: this.daemonToken,
        lifecycleId: this.presenceLifecycleId,
        releaseVersion: this.helperIdentity.releaseVersion,
        ...(this.helperIdentity.sourceSha ? { sourceSha: this.helperIdentity.sourceSha } : {}),
      }),
      onOpen: () => this.liveOpened(),
      onMessage: (event) => this.liveMessage(event),
      onClose: () => {
        for (const room of this.liveRooms.values())
          for (const registration of room.registrations) registration.onState?.(false);
      },
      // A settled removal is learned through the next reconcile's HTTP answer.
      onRefused: (code) => {
        if (code === AGENT_REMOVED_CODE) this.roomsChangedListener?.();
      },
      onUpdateRequired: (minVersion) => this.forceUpdateListener?.(minVersion),
    });
  }

  /** The machine socket under this agent's registration. */
  get link(): LiveLink {
    return this.machine.link;
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
    this.machine.setHelperIdentity(identity);
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
      reconnects: this.channel.reconnects,
      subscriptionsSent: this.subscriptionCount,
      readQueueDepth: budget?.waiting ?? 0,
      readQueueWaitMs: budget?.totalWaitMs ?? 0,
    };
  }

  /** Called on every live socket open, after resubscription and the wakes. */
  onLiveOpen(listener: () => void): () => void {
    return this.channel.onOpen(listener);
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
    let room = this.liveRooms.get(roomId);
    if (!room) {
      room = { pushedIds: new Set(), registrations: new Set() };
      this.liveRooms.set(roomId, room);
    }
    room.cursor = cursor ?? room.cursor;
    const registration = { onItems, onState, presence, onCommands };
    room.registrations.add(registration);
    this.ensureLiveSocket();
    this.sendLiveSubscription(roomId);
    return () => {
      if (!room.registrations.delete(registration) || room.registrations.size) return;
      this.liveRooms.delete(roomId);
      this.channel.send({ type: 'unsubscribe', roomId });
      if (!this.liveRooms.size && !this.roomsChangedListener) this.channel.stop();
    };
  }

  /** Register the one listener invoked when the server reports this agent's
   * Room/corner memberships changed — a scoped event applies incrementally;
   * an unscoped wake (reconnect) still runs the recovery reconcile. */
  setRoomsChangedListener(listener: (event?: RoomMembershipChange) => void): void {
    this.roomsChangedListener = listener;
    this.ensureLiveSocket();
  }

  /** Register the one listener invoked when the server reports the agent's
   * model/effort selection changed — the wake that hot-restarts every
   * retained session (agent-wide; the event names no single Room). */
  setConfigChangedListener(listener: () => void): void {
    this.configChangedListener = listener;
  }

  /** Connect / pending_ops drain wake. Never a catalog. */
  setConnectorAssignmentListener(listener: () => void): void {
    this.connectorAssignmentListener = listener;
  }

  /** Retire idle sessions as a phone-side config change does (a new provider key was saved). */
  emitConfigChanged(): void {
    this.configChangedListener?.();
  }

  /** One `@agent login` step the agent's owner started in a Room. */
  setAgentSignInListener(listener: (frame: AgentSignInFrame) => void): void {
    this.agentSignInListener = listener;
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

  /** Leave the machine socket when this agent's runtime stops. */
  closeLive(): void {
    this.channel.stop();
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
      if (this.readBudget && /^(get|list|read|search)/.test(operation)) {
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
          this.channel.requireUpdate(error.minVersion);
        throw error;
      }
      output = (await response.json()) as Output<Name>;
    } catch (error) {
      if (error instanceof ReadBudgetFullError) {
        throw new DaemonApiError(error.message, 429, true, 'read_budget_full', 1_000);
      }
      if (controller.signal.aborted) {
        this.timeoutCount += 1;
        // An admitted request that hears nothing for its whole deadline may be
        // riding a dead path; ask the socket. A queued one only waited here.
        if (admitted) this.channel.suspect();
        throw new DaemonApiError(`monolith daemon ${String(name)} timed out`, 408, true, 'deadline_exceeded');
      }
      if (isNetworkFailure(error)) this.channel.suspect();
      throw error;
    } finally {
      clearTimeout(deadline);
      if (admitted) this.inFlight -= 1;
      await release?.();
    }
    return output;
  }

  private ensureLiveSocket(): void {
    if (this.liveRooms.size || this.roomsChangedListener) this.channel.start();
  }

  private liveOpened(): void {
    for (const roomId of this.liveRooms.keys()) this.sendLiveSubscription(roomId);
    // Every wake on this socket is fire-and-forget: a membership written, or
    // a Connect tapped, while this socket was connecting (or between
    // reconnects) never replays its frame. Treat every open as both wakes,
    // so the reconciliation and the drain still reach them.
    this.roomsChangedListener?.();
    this.connectorAssignmentListener?.();
  }

  private liveMessage(event: Record<string, unknown>): void {
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
    if (event.type === 'agent-sign-in') {
      const frame = agentSignInFrame(event);
      if (frame) this.agentSignInListener?.(frame);
      return;
    }
    if (event.type === 'config-changed') {
      this.configChangedListener?.();
      return;
    }
    if (event.type === 'subscribed' && typeof event.roomId === 'string') {
      const capabilities = event.capabilities as Record<string, unknown> | undefined;
      for (const registration of this.liveRooms.get(event.roomId)?.registrations ?? [])
        registration.onState?.(true, {
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
      const commands = event.commands.filter((command): command is AgentCommand =>
        isAgentCommand(command) &&
        command.roomId === event.roomId &&
        command.agentId === this.agentId,
      );
      for (const registration of room.registrations) registration.onCommands?.(commands);
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
      for (const registration of room.registrations)
        registration.onItems?.(items, typeof event.cursor === 'string' ? event.cursor : undefined);
  }

  private sendLiveSubscription(roomId: string): void {
    const room = this.liveRooms.get(roomId);
    if (!room || !this.channel.isOpen()) return;
    this.subscriptionCount += 1;
    this.channel.send({
      type: 'subscribe',
      roomId,
      lifecycleId: this.presenceLifecycleId,
      ...(room.cursor ? { cursor: room.cursor } : {}),
      ...[...room.registrations].reverse().find((registration) => registration.presence)?.presence,
    });
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
  machine?: MachineLink,
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
        undefined,
        undefined,
        undefined,
        machine,
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
      undefined,
      undefined,
      undefined,
      machine,
    ),
  };
}
