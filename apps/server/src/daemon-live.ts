import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { isTransientDatabaseConnectionError } from './database.js';
import type { TokenAuth } from './auth.js';
import type { ConnectionPresence } from './connection-presence.js';
import type { DaemonService } from './daemon-service.js';
import type { HelperVersionGate } from './helper-version-gate.js';
import { helperVersionBelowMinimum } from './helper-version-gate.js';
import type { LiveHub, LiveTrace } from './live.js';
import type { PhoneService } from './phone-service.js';
import type { ReleaseNotifier } from './release-notify.js';
import type { SqlDatabase } from './database.js';

/** The server pings every helper socket this often and drops one that missed the last ping. */
export const LIVE_HEARTBEAT_MS = 30_000;
/** One machine socket carries at most this many agents. */
export const MAX_MACHINE_AGENTS = 64;
/** A machine socket that registers no agent in this window is closed. */
export const MACHINE_REGISTRATION_DEADLINE_MS = 30_000;
/** Subprotocol a helper names to open one socket for every agent on its machine. */
export const MACHINE_SOCKET_PROTOCOL = 'beeline.machine.1';

export const MAX_LIVE_SESSION_TASKS = 8_192;
export const MAX_LIVE_SESSION_QUEUED_BYTES = 2 * 1024 * 1024;
export const MAX_LIVE_ROOMS_PER_SESSION = 8_192;
export const MAX_LIVE_SUBSCRIBE_FRAME_ROOMS = 32;

export interface DaemonLiveDependencies {
  readonly auth: TokenAuth;
  readonly phone: PhoneService;
  readonly daemon: DaemonService;
  readonly live: LiveHub;
  readonly database: SqlDatabase;
  readonly connectionPresence?: ConnectionPresence;
  readonly releaseNotify?: ReleaseNotifier;
  readonly helperVersionGate: HelperVersionGate;
  readonly acquireLiveDbTask: () => Promise<() => void>;
  readonly errors: { database: number; invalid: number; internal: number; overload: number };
  readonly counters: { helperVersionRefusals: number; helperForceUpdates: number };
  readonly registry: DaemonConnectionRegistry;
  /** True while this server is shutting down: its connections stay held for the successor. */
  readonly shuttingDown: () => boolean;
}

function isInboxCursor(value: unknown): value is string {
  return typeof value === 'string' && /^\d+,[0-9a-f]{64}$/.test(value);
}

function isRetryableLiveError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return isTransientDatabaseConnectionError(error) || code === '57014' || code === '53300';
}

/**
 * Newest connection wins, per agent, across old per-agent sockets and machine
 * registrations on this server. Across server instances the connection epoch
 * decides: an instance drops its own session once it learns of a newer epoch.
 */
export class DaemonConnectionRegistry {
  readonly #sessions = new Map<string, DaemonAgentSession>();
  readonly #newestEpoch = new Map<string, number>();

  claim(session: DaemonAgentSession): void {
    const previous = this.#sessions.get(session.agentId);
    this.#sessions.set(session.agentId, session);
    if (previous && previous !== session) previous.evict('replaced');
  }

  release(session: DaemonAgentSession): void {
    if (this.#sessions.get(session.agentId) === session) this.#sessions.delete(session.agentId);
  }

  /** Some instance accepted connection `epoch` for this agent. */
  observeEpoch(agentId: string, epoch: number): void {
    if (epoch > (this.#newestEpoch.get(agentId) ?? 0)) this.#newestEpoch.set(agentId, epoch);
    this.#settle(agentId);
  }

  /** This instance's session learned its own epoch. */
  settled(session: DaemonAgentSession): void {
    this.#settle(session.agentId);
  }

  #settle(agentId: string): void {
    const session = this.#sessions.get(agentId);
    const newest = this.#newestEpoch.get(agentId) ?? 0;
    if (session?.epoch !== undefined && session.epoch < newest) session.evict('replaced');
    // Only the newest epoch matters; forget it once no session can be older.
    if (!session) this.#newestEpoch.delete(agentId);
  }
}

/** How a session reaches its helper: a whole old socket, or one registration on a machine socket. */
export interface DaemonSessionTransport {
  send(event: Record<string, unknown>): void;
  isOpen(): boolean;
  /** Ends this agent's session: an old socket closes; a registration is dropped. */
  drop(code: number, reason: string): void;
  /** False after the socket refused a frame for its helper version. */
  admit(item: Record<string, unknown>): boolean;
}

/**
 * One agent's live session: authorization, Room subscriptions, command intake,
 * wakes and its own bounded task queue. A machine socket holds one per
 * registered agent, so one agent's overload or failure drops only its own.
 */
export class DaemonAgentSession {
  readonly connectionId = randomUUID();
  epoch: number | undefined;
  readonly #releases = new Map<string, () => void>();
  readonly #wakeReleases: Array<() => void> = [];
  #tasks = 0;
  #queuedBytes = 0;
  #tail = Promise.resolve();
  #closed = false;
  #claimed = false;

  constructor(
    private readonly deps: DaemonLiveDependencies,
    readonly agentId: string,
    private readonly transport: DaemonSessionTransport,
    private readonly presence: {
      lifecycleId?: string;
      releaseVersion?: string;
      sourceSha?: string;
    } = {},
  ) {
    const { live, database } = deps;
    // A fresh Room (or any Room/corner membership change) inserts a
    // `memberships` row whose live notification is Room-scoped — a Room this
    // daemon has never heard of, so it holds no socket subscription for it.
    // Deliver an agent-directed wake instead so discovery starts now.
    this.#wakeReleases.push(
      live.subscribeAll((event) => {
        if (event.type === 'agent-sign-in') {
          // Only this agent's own helper hears its sign-in steps; the
          // link/result answers stay on the server for the waiting phone.
          if (event.agentId !== agentId || !transport.isOpen()) return;
          if (event.step === 'start')
            transport.send({
              type: 'agent-sign-in',
              step: 'start',
              attemptId: event.attemptId,
              cardId: event.cardId,
            });
          else if (event.step === 'code')
            transport.send({
              type: 'agent-sign-in',
              step: 'code',
              attemptId: event.attemptId,
              code: event.code,
            });
          return;
        }
        if (
          event.type !== 'invalidate' ||
          event.targetAgentId !== agentId ||
          !transport.isOpen()
        )
          return;
        if (event.reason === 'connector-assignment') {
          transport.send({ type: 'connector-assignment' });
          return;
        }
        if (event.reason !== 'postgres:memberships') return;
        transport.send({
          type: 'rooms-changed',
          ...(event.roomId ? { roomId: event.roomId } : {}),
          ...(event.parentRoomId ? { parentRoomId: event.parentRoomId } : {}),
          ...(event.openedBy ? { openedBy: event.openedBy } : {}),
          ...(event.archived ? { archived: true } : {}),
          ...(event.removed ? { removed: true } : {}),
        });
      }),
      live.subscribeResync(() =>
        transport.send({ type: 'discovery-wake', reason: 'listener-resync' }),
      ),
    );
    const recovery = database.onRecovery?.(() =>
      transport.send({ type: 'discovery-wake', reason: 'database-recovered' }),
    );
    if (recovery) this.#wakeReleases.push(recovery);
  }

  get subscriptions(): number {
    return this.#releases.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Record this connection as the agent's newest and hold its presence. A
   * failed write is logged: intake still works, presence then rides on the
   * per-Room announcements and HTTP evidence exactly as before.
   */
  async claim(): Promise<void> {
    this.deps.registry.claim(this);
    const presence = this.deps.connectionPresence;
    if (!presence) return;
    try {
      const epoch = await presence.claimConnection(this.agentId, {
        connectionId: this.connectionId,
        ...this.presence,
      });
      this.#claimed = true;
      if (this.#closed) {
        await this.#releaseConnection();
        return;
      }
      this.epoch = epoch;
      this.deps.registry.settled(this);
    } catch (error) {
      console.error('[presence] connection claim failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** A newer connection for this agent exists (here or on another server). */
  evict(reason: string): void {
    if (this.#closed) return;
    this.transport.drop(4001, reason);
    this.close();
  }

  /** Queue one frame behind this agent's earlier frames. */
  frame(raw: Record<string, unknown>, frameBytes: number): void {
    if (this.#closed) return;
    if (this.#tasks >= MAX_LIVE_SESSION_TASKS ||
        this.#queuedBytes + frameBytes > MAX_LIVE_SESSION_QUEUED_BYTES) {
      this.deps.errors.overload++;
      this.transport.drop(1013, 'live admission overloaded');
      this.close();
      return;
    }
    this.#tasks++;
    this.#queuedBytes += frameBytes;
    this.#tail = this.#tail.then(async () => {
      if (this.#closed || !this.transport.isOpen()) return;
      const releaseDbTask = await this.deps.acquireLiveDbTask();
      try {
        if (!this.#closed && this.transport.isOpen()) await this.#process(raw);
      } finally {
        releaseDbTask();
      }
    }).catch((error) => {
      const retryable = isRetryableLiveError(error);
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      const kind = retryable ? 'database' : code === '22P02' ? 'invalid' : 'internal';
      this.deps.errors[kind]++;
      console.error('[live] message failed', { kind, error });
      if (!this.#closed && this.transport.isOpen()) {
        this.transport.drop(
          retryable || (error instanceof Error && error.message === 'live admission overloaded')
            ? 1013 : 1011,
          'live request failed',
        );
        this.close();
      }
    }).finally(() => {
      this.#tasks--;
      this.#queuedBytes -= frameBytes;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const release of this.#wakeReleases.splice(0)) release();
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
    this.deps.registry.release(this);
    void this.#releaseConnection();
  }

  async #releaseConnection(): Promise<void> {
    if (!this.#claimed || this.deps.shuttingDown()) return;
    this.#claimed = false;
    await this.deps.connectionPresence?.releaseConnection(this.agentId, this.connectionId)
      .catch((error) => console.error('[presence] connection release failed',
        error instanceof Error ? error.message : String(error)));
  }

  async #process(item: Record<string, unknown>): Promise<void> {
    if (!this.transport.admit(item)) return;
    if (item.type === 'unsubscribe' && typeof item.roomId === 'string') {
      this.#releases.get(item.roomId)?.();
      this.#releases.delete(item.roomId);
      return;
    }
    if (item.type !== 'subscribe') return;
    const requestedRoomIds = Array.isArray(item.roomIds)
      ? [
          ...new Set(
            (item.roomIds as unknown[]).filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
            ),
          ),
        ]
      : typeof item.roomId === 'string'
        ? [item.roomId]
        : [];
    if (requestedRoomIds.length === 0) return;
    if (requestedRoomIds.length > MAX_LIVE_SUBSCRIBE_FRAME_ROOMS ||
        this.#releases.size + requestedRoomIds.filter((id) => !this.#releases.has(id)).length >
          MAX_LIVE_ROOMS_PER_SESSION) {
      this.deps.errors.invalid++;
      this.transport.drop(1008, 'live subscription limit');
      this.close();
      return;
    }
    const readableRooms = await this.deps.phone.canReadRooms(requestedRoomIds, this.agentId);
    for (const roomId of requestedRoomIds) {
      if (!readableRooms.has(roomId) || this.#releases.has(roomId) || this.#closed) continue;
      await this.#subscribe(roomId, item);
    }
  }

  async #subscribe(roomId: string, item: Record<string, unknown>): Promise<void> {
    const { live, daemon } = this.deps;
    const transport = this.transport;
    const agentId = this.agentId;
    let cursor = isInboxCursor(item.cursor) ? item.cursor : undefined;
    let replaying = false;
    let replayRequested = false;
    let replayTrigger: { reason: string; trace: LiveTrace } | undefined;
    let commandsPushing = false;
    let commandsRequested = false;
    let commandTrigger: { reason: string; trace: LiveTrace } | undefined;
    const replay = async (trigger?: { reason: string; trace: LiveTrace }) => {
      replayRequested = true;
      if (trigger) replayTrigger = trigger;
      if (replaying) return;
      replaying = true;
      try {
        while (replayRequested && transport.isOpen() && !this.#closed) {
          replayRequested = false;
          const inbox = await daemon.execute(
            'getRoomInbox',
            {
              roomId,
              ...(cursor ? { after: cursor, rewind: true } : { startAtLatest: true }),
              limit: 200,
            },
            agentId,
          );
          cursor = inbox.cursor ?? cursor;
          const currentTrigger = replayTrigger;
          replayTrigger = undefined;
          transport.send({
            type: 'inbox',
            roomId,
            items: inbox.items,
            ...(cursor ? { cursor } : {}),
            ...(currentTrigger ? { trigger: currentTrigger } : {}),
          });
        }
      } catch (error) {
        console.error(
          '[live] daemon replay failed',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        replaying = false;
      }
    };
    const pushCommands = async (trigger?: { reason: string; trace: LiveTrace }) => {
      commandsRequested = true;
      if (trigger) commandTrigger = trigger;
      if (commandsPushing) return;
      commandsPushing = true;
      try {
        while (commandsRequested && transport.isOpen() && !this.#closed) {
          commandsRequested = false;
          const page = await daemon.execute('getAgentCommands', { roomId }, agentId);
          const currentTrigger = commandTrigger;
          commandTrigger = undefined;
          transport.send({
            type: 'commands',
            roomId,
            commandProtocol: page.commandProtocol,
            commands: page.commands,
            ...(currentTrigger ? { trigger: currentTrigger } : {}),
          });
        }
      } catch (error) {
        console.error(
          '[live] daemon command push failed',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        commandsPushing = false;
      }
    };
    this.#releases.set(
      roomId,
      live.subscribe(roomId, (event) => {
        // Presence and streaming overlays are not durable inbox
        // invalidations. Replaying for them turns every evidence
        // refresh into an unrelated Room read on every daemon
        // listener. Commands have their own targeted projection;
        // their source message is delivered by its message event.
        if (event.type !== 'invalidate') return;
        // Read marks only reconcile the reader's phone devices.
        if (event.readerId) return;
        // A child corner's status changed; only corner lists read it.
        if (event.reason === 'corner-status') return;
        const trigger = event.trace
          ? { reason: event.reason, trace: event.trace }
          : undefined;
        if (event.reason === 'agent-config') {
          // A phone-side model/effort selection change for this
          // agent. No inbox replay: the durable fact is the
          // agent-model system line, and the daemon needs only the
          // wake to hot-restart its retained sessions.
          if (event.targetAgentId === agentId && transport.isOpen())
            transport.send({ type: 'config-changed', roomId });
          return;
        }
        if (event.reason === 'postgres:agent_commands') {
          if (event.targetAgentId === agentId) void pushCommands(trigger);
          return;
        }
        if (event.reason === 'postgres:rooms' && event.repositoryChanged) {
          if (transport.isOpen())
            transport.send({ type: 'rooms-changed', roomId, repositoryChanged: true });
          return;
        }
        if (event.closeRequested && event.reason === 'postgres:corner_facts') {
          if (transport.isOpen()) transport.send({ type: 'corner-complete', roomId });
          return;
        }
        if (
          event.reason === 'postgres:corner_facts' &&
          event.laneChanged &&
          event.lane === 'code'
        ) {
          if (transport.isOpen()) transport.send({ type: 'corner-restart', roomId });
          return;
        }
        void replay(trigger);
      }),
    );
    const lifecycleId =
      typeof item.lifecycleId === 'string' && item.lifecycleId.length <= 128
        ? item.lifecycleId
        : undefined;
    if (lifecycleId)
      try {
        await this.deps.connectionPresence?.announce(roomId, agentId, {
          lifecycleId,
          ...(typeof item.releaseVersion === 'string'
            ? { releaseVersion: item.releaseVersion }
            : {}),
          ...(typeof item.sourceSha === 'string' ? { sourceSha: item.sourceSha } : {}),
          ...(typeof item.available === 'boolean' ? { available: item.available } : {}),
        });
      } catch (error) {
        console.error('[presence] startup announcement failed', error);
      }
    if (!transport.isOpen() || this.#closed) return;
    transport.send({
      type: 'subscribed',
      roomId,
      capabilities: {
        pushIntake: true,
        connectionPresence: Boolean(this.deps.connectionPresence),
        discoveryWake: true,
      },
    });
    // Both projections use the app pool. Keep one session's startup
    // reads inside its single admission slot instead of doubling
    // connection demand during a reconnect fan-in.
    await replay();
    await pushCommands();
  }
}

/** The helper version a daemon socket reported, and the server minimum it is held to. */
class HelperVersionGuard {
  #pushedMinimum: string | undefined;
  readonly #release: () => void;

  constructor(
    private readonly deps: DaemonLiveDependencies,
    private version: string | undefined,
    private readonly send: (payload: string) => void,
    private readonly close: (code: number, reason: string) => void,
  ) {
    this.#release = deps.helperVersionGate.subscribe((minimum) => {
      if (this.#forceUpdate(minimum)) close(1008, 'update required');
    });
  }

  learn(version: string): void {
    this.version ??= version;
  }

  #forceUpdate(minimum: string): boolean {
    if (!helperVersionBelowMinimum(this.version, minimum) || this.#pushedMinimum === minimum)
      return false;
    this.#pushedMinimum = minimum;
    this.deps.counters.helperForceUpdates++;
    this.send(JSON.stringify({ type: 'force-update', minVersion: minimum }));
    return true;
  }

  /** False when the socket was closed for its version. */
  admit(): boolean {
    const minimum = this.deps.helperVersionGate.minimum;
    if (!minimum) return true;
    if (this.#forceUpdate(minimum) || helperVersionBelowMinimum(this.version, minimum)) {
      this.deps.counters.helperVersionRefusals++;
      this.close(1008, 'update required');
      return false;
    }
    return true;
  }

  dispose(): void {
    this.#release();
  }
}

type SendLive = (payload: string) => void;

function frameBytes(raw: Buffer | ArrayBuffer | Buffer[]): number {
  return Array.isArray(raw) ? raw.reduce((total, part) => total + part.length, 0) : raw.byteLength;
}

function parseFrame(raw: Buffer | ArrayBuffer | Buffer[]): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(
      Array.isArray(raw) ? Buffer.concat(raw).toString() : Buffer.from(raw as ArrayBuffer).toString(),
    ) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A pre-machine helper: one socket authenticated as one agent at upgrade.
 * It is one session; the socket's frames carry no agent id.
 */
export function serveAgentSocket(
  deps: DaemonLiveDependencies,
  client: WebSocket,
  principal: { identityId: string; helperVersion?: string; helperSourceSha?: string },
  sendLive: SendLive,
  trackSubscriptions: (count: () => number) => void,
): void {
  const guard = new HelperVersionGuard(
    deps, principal.helperVersion, sendLive, (code, reason) => client.close(code, reason),
  );
  const isOpen = () => client.readyState === client.OPEN;
  const send = (event: Record<string, unknown>) => {
    if (isOpen()) sendLive(JSON.stringify(event));
  };
  sendLive(JSON.stringify({
    type: 'hello',
    protocolMin: 1,
    protocolMax: 1,
    capabilities: { discoveryWake: true, pushIntake: true },
    ...(principal.helperVersion ? { reportedHelper: {
      releaseVersion: principal.helperVersion,
      ...(principal.helperSourceSha ? { sourceSha: principal.helperSourceSha } : {}),
    } } : {}),
  }));
  const session = new DaemonAgentSession(deps, principal.identityId, {
    send,
    isOpen,
    drop: (code, reason) => {
      // A newer connection replaced this socket: it holds nothing worth a
      // graceful close, and its count was already released at upgrade.
      if (code === 4001) client.terminate();
      else if (isOpen()) client.close(code, reason);
    },
    admit: (item) => {
      if (item.type === 'subscribe' && typeof item.releaseVersion === 'string')
        guard.learn(item.releaseVersion);
      return guard.admit();
    },
  });
  void session.claim();
  trackSubscriptions(() => session.subscriptions);
  const releaseSubscription = deps.releaseNotify?.subscribeHelperRelease((release) =>
    send({ type: 'helper-release', ...release }),
  );
  client.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    if (!guard.admit()) return;
    const bytes = frameBytes(raw);
    const item = parseFrame(raw);
    if (!item) {
      deps.errors.invalid++;
      return;
    }
    session.frame(item, bytes);
  });
  client.on('close', () => {
    guard.dispose();
    releaseSubscription?.();
    session.close();
  });
}

/**
 * One socket for every agent on a helper machine. The socket itself carries no
 * identity: each agent registers with its own daemon token, and a refused,
 * revoked or overloaded agent loses only its own registration.
 */
export function serveMachineSocket(
  deps: DaemonLiveDependencies,
  client: WebSocket,
  principal: { helperVersion?: string; helperSourceSha?: string },
  sendLive: SendLive,
  trackSubscriptions: (count: () => number) => void,
  heartbeatMs: number,
): void {
  const sessions = new Map<string, DaemonAgentSession>();
  const registering = new Set<string>();
  const guard = new HelperVersionGuard(
    deps, principal.helperVersion, sendLive, (code, reason) => client.close(code, reason),
  );
  const isOpen = () => client.readyState === client.OPEN;
  const send = (event: Record<string, unknown>) => {
    if (isOpen()) sendLive(JSON.stringify(event));
  };
  trackSubscriptions(() => [...sessions.values()].reduce((sum, session) => sum + session.subscriptions, 0));
  send({
    type: 'hello',
    protocol: 'machine',
    protocolMin: 1,
    protocolMax: 1,
    heartbeatMs,
    capabilities: { discoveryWake: true, pushIntake: true },
    ...(principal.helperVersion ? { reportedHelper: {
      releaseVersion: principal.helperVersion,
      ...(principal.helperSourceSha ? { sourceSha: principal.helperSourceSha } : {}),
    } } : {}),
  });
  const registrationDeadline = setTimeout(() => {
    if (sessions.size === 0 && registering.size === 0 && isOpen())
      client.close(1008, 'registration required');
  }, MACHINE_REGISTRATION_DEADLINE_MS);
  registrationDeadline.unref?.();
  const releaseSubscription = deps.releaseNotify?.subscribeHelperRelease((release) =>
    send({ type: 'helper-release', ...release }),
  );
  const unregistered = (agentId: string, reason: string, code?: number) =>
    send({ type: 'unregistered', agentId, reason, ...(code ? { code } : {}) });

  const register = async (item: Record<string, unknown>) => {
    const agentId = item.agentId;
    const token = item.token;
    if (typeof agentId !== 'string' || !/^[0-9a-f]{64}$/i.test(agentId)) {
      deps.errors.invalid++;
      return;
    }
    if (typeof token !== 'string' || !token.startsWith('bdt_')) {
      send({ type: 'register-refused', agentId, code: 'daemon_token_required' });
      return;
    }
    if (registering.has(agentId)) return;
    if (!sessions.has(agentId) && sessions.size + registering.size >= MAX_MACHINE_AGENTS) {
      deps.errors.overload++;
      send({ type: 'register-refused', agentId, code: 'too_many_agents' });
      return;
    }
    registering.add(agentId);
    try {
      const authenticated = await deps.auth.authenticateDaemon(token);
      if (!isOpen()) return;
      if (authenticated !== agentId) {
        // The same two answers HTTP gives: a settled removal, or a token to retry.
        const retired = authenticated ? null : await deps.auth.retiredDaemonAgent(token);
        send({
          type: 'register-refused',
          agentId,
          code: retired ? 'agent_removed' : 'daemon_token_required',
        });
        return;
      }
      sessions.get(agentId)?.close();
      const session: DaemonAgentSession = new DaemonAgentSession(
        deps,
        agentId,
        {
          send: (event) => send({ ...event, agentId }),
          isOpen: (): boolean => isOpen() && sessions.get(agentId) === session,
          drop: (code, reason) => {
            if (sessions.get(agentId) !== session) return;
            sessions.delete(agentId);
            unregistered(agentId, reason, code);
          },
          admit: () => guard.admit(),
        },
        {
          ...(typeof item.lifecycleId === 'string' && item.lifecycleId.length <= 128
            ? { lifecycleId: item.lifecycleId } : {}),
          ...(typeof item.releaseVersion === 'string' ? { releaseVersion: item.releaseVersion } : {}),
          ...(typeof item.sourceSha === 'string' ? { sourceSha: item.sourceSha } : {}),
          ...(typeof item.available === 'boolean' ? { available: item.available } : {}),
        },
      );
      sessions.set(agentId, session);
      await session.claim();
      if (session.closed || sessions.get(agentId) !== session) return;
      send({
        type: 'registered',
        agentId,
        capabilities: { discoveryWake: true, pushIntake: true },
      });
    } catch (error) {
      deps.errors.internal++;
      console.error('[live] agent registration failed', error instanceof Error ? error.message : String(error));
      if (isOpen()) send({ type: 'register-refused', agentId, code: 'registration_failed' });
    } finally {
      registering.delete(agentId);
    }
  };

  client.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    if (!guard.admit()) return;
    const bytes = frameBytes(raw);
    const item = parseFrame(raw);
    if (!item) {
      deps.errors.invalid++;
      return;
    }
    if (item.type === 'register') {
      void register(item);
      return;
    }
    const agentId = typeof item.agentId === 'string' ? item.agentId : undefined;
    const session = agentId ? sessions.get(agentId) : undefined;
    if (!session) {
      deps.errors.invalid++;
      return;
    }
    if (item.type === 'unregister') {
      sessions.delete(session.agentId);
      session.close();
      return;
    }
    session.frame(item, bytes);
  });
  client.on('close', () => {
    clearTimeout(registrationDeadline);
    guard.dispose();
    releaseSubscription?.();
    for (const session of sessions.values()) session.close();
    sessions.clear();
  });
}
