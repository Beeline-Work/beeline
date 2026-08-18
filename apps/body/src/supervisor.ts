import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';
import {
  createBuzzClient,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  type RepositoryBinding,
} from '@beeline/buzz-client';
import { gitAuthed, gitWithUserCredentials, type Identity } from '@beeline/gate';
import { Body, type BoundRepo } from './body.js';
import type { BodyConfig } from './config.js';
import type { NamedRepositoryTarget } from './repository-target.js';
import {
  inspectLocalRepository,
  runtimeIdentity,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
  type LocalRepositoryBinding,
  type RoomRuntimeRecord,
} from './runtime.js';
import { SharedRelaySocket } from './relay-socket.js';
import {
  DEFAULT_PER_ROOM_LIVE_SESSIONS,
  DEFAULT_WORKSPACE_LIVE_SESSIONS_FLOOR,
  SessionScheduler,
} from './session-scheduler.js';

interface RunningRoom {
  body: Body;
  controller: AbortController;
  promise: Promise<void>;
  /** Last successful Room request poll (not merely a running JS promise). */
  lastPollAt: number;
  /** Last presence marker the relay accepted for this Room. */
  lastPresenceAt: number;
  presence: 'online' | 'offline';
  /** A Room-directed retry delay. The watchdog must not erase this backoff. */
  backoffUntil: number;
  recovering: boolean;
}

interface DesiredChannel {
  membershipSince: number;
  kind: 'repository' | 'named-repository' | 'direct-message';
  repositoryRoom?: RoomRuntimeRecord;
}

function relayRepoFromBinding(
  binding: RepositoryBinding,
): { ownerHex: string; repo: string } | undefined {
  if (!binding.remote) return undefined;
  const match = binding.remote.match(/\/git\/([0-9a-fA-F]{64})\/([^/]+?)\/?$/);
  if (!match) return undefined;
  return { ownerHex: match[1]!.toLowerCase(), repo: decodeURIComponent(match[2]!) };
}

function cloneUrl(binding: RepositoryBinding): string {
  if (!binding.remote) throw new Error('repository Room has no cloneable remote');
  if (binding.remote.startsWith('git://')) {
    return `https://${binding.remote.slice('git://'.length)}.git`;
  }
  return binding.remote;
}

export function boundRepoFromRoom(room: RoomRuntimeRecord): BoundRepo {
  return {
    repo: room.repo.relayRepo?.repo ?? room.repo.repository.name,
    ...(room.repo.relayRepo ? { ownerHex: room.repo.relayRepo.ownerHex } : {}),
    targetBranch: `refs/heads/${room.repo.targetBranch}`,
    localPath: room.repo.root,
    ...(room.repo.remoteName ? { remoteName: room.repo.remoteName } : {}),
    repositoryKey: room.repo.repository.key,
    localOnly: room.repo.repository.localOnly,
  };
}

function reconcileRetryMs(error: unknown, pollMs: number): number {
  const match = String(error).match(/retry in\s+(\d+)s/i);
  return match ? Math.max(pollMs, (Number(match[1]) + 1) * 1_000) : pollMs;
}

export const DEFAULT_ROOM_WATCHDOG_STALE_MS = 90_000;

/**
 * Long-interval correctness backstop for Workspace discovery (`reconcile()`)
 * once the control-plane WS subscription (see `run()`) is driving it instead
 * of a 5s poll. A missed/dropped WS push (including the removal signal) can
 * therefore never silently strand a stale membership set past this interval.
 */
export const DEFAULT_RECONCILE_HEARTBEAT_MS = 60_000;

/** One durable Workspace control plane multiplexing isolated Room bodies. */
export class WorkspaceSupervisor {
  private runtime: AgentRuntimeRecord;
  private readonly configPath: string;
  private readonly baseConfig: BodyConfig;
  private readonly agent: Identity;
  private readonly running = new Map<string, RunningRoom>();
  private readonly scheduler: SessionScheduler;
  /**
   * One authenticated relay WS for the whole daemon. Every Room push loop,
   * every Room presence cache and the control plane below multiplex their own
   * NIP-01 subId onto it, instead of opening ~N+1 sockets on one agent pubkey.
   */
  private readonly relaySocket: SharedRelaySocket;
  private readonly namedRepositoryResolutions = new Map<string, Promise<BoundRepo>>();
  private readonly now: () => number;
  private readonly watchdogStaleMs: number;
  private readonly reconcileHeartbeatMs: number;

  constructor(
    runtime: AgentRuntimeRecord,
    configPath: string,
    baseConfig: BodyConfig,
    options: { now?: () => number; watchdogStaleMs?: number; reconcileHeartbeatMs?: number } = {},
  ) {
    this.runtime = runtime;
    this.configPath = configPath;
    this.baseConfig = baseConfig;
    this.agent = runtimeIdentity(runtime.agent);
    // Capacity is budgeted per Room under a Workspace ceiling that grows with
    // the number of Rooms this daemon serves. BUZZY_BODY_MAX_SESSIONS still
    // pins a fixed Workspace ceiling when an operator sets it explicitly.
    const fixedWorkspaceCeiling = process.env.BUZZY_BODY_MAX_SESSIONS;
    this.scheduler = new SessionScheduler({
      ...(fixedWorkspaceCeiling ? { maxLiveSessions: Number(fixedWorkspaceCeiling) } : {}),
      perRoomLiveSessions: Number(
        process.env.BUZZY_BODY_MAX_SESSIONS_PER_ROOM ?? String(DEFAULT_PER_ROOM_LIVE_SESSIONS),
      ),
      workspaceFloor: Number(
        process.env.BUZZY_BODY_MAX_SESSIONS_FLOOR ??
          String(DEFAULT_WORKSPACE_LIVE_SESSIONS_FLOOR),
      ),
      activeRoomCount: () => this.running.size,
      idleMs: Number(process.env.BUZZY_BODY_SESSION_IDLE_MS ?? String(5 * 60_000)),
      reserveInteractiveSlot: true,
    });
    this.relaySocket = new SharedRelaySocket({
      baseUrl: runtime.relayBaseUrl,
      ...(runtime.relayHost ? { host: runtime.relayHost } : {}),
      ...(baseConfig.relayWsUrl ? { wsUrl: baseConfig.relayWsUrl } : {}),
      identity: this.agent,
      WebSocketImpl: WebSocket,
    });
    this.now = options.now ?? Date.now;
    this.watchdogStaleMs =
      options.watchdogStaleMs ??
      Number(process.env.BUZZY_BODY_ROOM_WATCHDOG_STALE_MS ?? DEFAULT_ROOM_WATCHDOG_STALE_MS);
    this.reconcileHeartbeatMs =
      options.reconcileHeartbeatMs ??
      Number(process.env.BUZZY_BODY_RECONCILE_HEARTBEAT_MS ?? DEFAULT_RECONCILE_HEARTBEAT_MS);
  }

  activeRoomIds(): string[] {
    return [...this.running.keys()].sort();
  }

  /**
   * Membership discovery (`reconcile()`) no longer runs on a blind 5s forever
   * poll. A persistent control-plane WS subscribes once to this agent's own
   * put/remove-user events (kind 9000/9001, `#p`-filtered — the durable NIP-29
   * mutation log, not the replaceable 39001/39002 projection, so a removal
   * event still carries this agent's pubkey even though the *resulting*
   * projection no longer would) and wakes `reconcile()` on demand instead.
   * `DEFAULT_RECONCILE_HEARTBEAT_MS` is a long-interval correctness backstop:
   * `reconcile()` still runs on that cadence even with zero WS activity, so a
   * socket that never connects, drops, or silently misses a push can never
   * strand a stale membership set (including a missed removal) indefinitely.
   * The Room watchdog stays on the tight `pollMs` tick below — it only reads
   * already-local timestamps, so it costs no relay traffic either way.
   */
  async run(
    opts: { pollMs?: number; signal?: AbortSignal } = {},
  ): Promise<'aborted' | 'agent-removed'> {
    const watchdogTickMs = opts.pollMs ?? 5_000;
    let wake = true; // reconcile once immediately on startup, same as before
    let nextReconcileAt = 0;
    let unsubscribeControl: (() => void) | undefined;
    try {
      // The control plane is one more subId on the daemon's shared socket, not
      // its own connection.
      const candidate = await this.relaySocket.connected();
      const socket = candidate.socket;
      if (!socket) throw new Error('control-plane WS connected but exposed no socket');
      unsubscribeControl = socket.subscribe(
        [
          {
            kinds: [KIND_PUT_USER, KIND_REMOVE_USER],
            '#p': [this.agent.publicKey],
            since: Math.floor(this.now() / 1000),
          },
        ],
        () => {
          wake = true;
        },
      );
    } catch (error) {
      console.error(
        `[supervisor] control-plane WS unavailable; relying on the ` +
          `${this.reconcileHeartbeatMs}ms heartbeat poll:`,
        error,
      );
    }
    try {
      while (!opts.signal?.aborted) {
        let waitMs = watchdogTickMs;
        if (wake || this.now() >= nextReconcileAt) {
          wake = false;
          try {
            if (!(await this.reconcile())) return 'agent-removed';
            nextReconcileAt = this.now() + this.reconcileHeartbeatMs;
          } catch (error) {
            // Membership discovery is a control-plane read. A transient relay
            // error must not tear down every active Room (and therefore restart
            // their pinned ACP processes). Keep serving the last known set and
            // honor the relay's advertised backoff before reconciling again.
            const retryMs = reconcileRetryMs(error, watchdogTickMs);
            nextReconcileAt = this.now() + retryMs;
            waitMs = Math.min(waitMs, retryMs);
            console.error(`[supervisor] discovery failed; retrying in ${retryMs}ms:`, error);
          }
        }
        // Keep Room recovery independent from Workspace discovery: a transient
        // control-plane read cannot prevent the watchdog from reviving a
        // stale Room already known to this daemon.
        await this.watchdog();
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, waitMs);
          opts.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolveWait();
            },
            { once: true },
          );
        });
      }
      return 'aborted';
    } finally {
      unsubscribeControl?.();
      // Rooms still drain their own REQs over the shared socket, so it can only
      // be closed once every Body has stopped.
      await this.stopAll();
      await this.scheduler.dispose();
      this.relaySocket.disconnect();
    }
  }

  async reconcile(): Promise<boolean> {
    const client = createBuzzClient({
      baseUrl: this.runtime.relayBaseUrl,
      ...(this.runtime.relayHost ? { host: this.runtime.relayHost } : {}),
      identity: this.agent,
    });
    try {
      // Workspace membership is the paired runtime's durable lease. A
      // successful projection read showing removal is authoritative; transient
      // relay failures still throw and retain the last known running set.
      if (!(await client.isMember(this.runtime.communityId, this.agent.publicKey))) {
        console.log(
          `[supervisor] agent removed from Workspace ${this.runtime.communityId}; draining runtime`,
        );
        return false;
      }
      const memberships = await client.listMyChannels();
      const desired = new Map<string, DesiredChannel>();
      for (const membership of memberships) {
        const channelId = membership.channelId;
        // listMyChannels reads the relay's current member/admin projections.
        // Known Rooms need no further control-plane queries: disappearing
        // from this list is the authoritative removal signal.
        const knownRoom = this.runtime.rooms.find((candidate) => candidate.channelId === channelId);
        if (knownRoom) {
          desired.set(channelId, {
            membershipSince: membership.event.created_at,
            kind: 'repository',
            repositoryRoom: knownRoom,
          });
          continue;
        }
        if ((await client.getChannelCommunityId(channelId)) !== this.runtime.communityId) continue;
        if (channelId === this.runtime.communityId) continue;
        if (await client.getParentChannelId(channelId)) continue;
        const binding = await client.getChannelRepositoryBinding(channelId);
        if (binding) {
          desired.set(channelId, {
            membershipSince: membership.event.created_at,
            kind: 'repository',
          });
          continue;
        }
        const dm = await client.getDirectMessage(channelId);
        desired.set(channelId, {
          membershipSince: membership.event.created_at,
          kind:
            dm && dm.participants.includes(this.agent.publicKey)
              ? 'direct-message'
              : 'named-repository',
        });
      }

      for (const [channelId, running] of [...this.running]) {
        if (desired.has(channelId)) continue;
        // Stop intake first. Body drains accepted turns before dispose returns.
        running.controller.abort();
        await running.promise.catch(() => undefined);
      }

      for (const [channelId, target] of desired) {
        if (this.running.has(channelId)) continue;
        if (target.kind === 'repository') {
          let room = this.runtime.rooms.find((candidate) => candidate.channelId === channelId);
          if (!room) {
            const binding = await client.getChannelRepositoryBinding(channelId);
            if (binding) {
              room = await this.materializeRoom(channelId, target.membershipSince, binding);
              this.runtime.rooms.push(room);
              await writeRuntimeRecord(this.runtime);
            } else {
              room = target.repositoryRoom;
            }
          }
          if (room) this.startRepositoryRoom(room, channelId);
        } else {
          this.startConversationRoom(channelId, target.kind);
        }
      }
      return true;
    } finally {
      client.disconnect();
    }
  }

  /**
   * Room storage root. `RoomRuntimeRecord.root` is explicit for Rooms created
   * once the runtime moved off the paired repo's `.git`; a record written
   * before that carries no root and keeps resolving to its existing location
   * under the runtime config directory. Never derive over an explicit root —
   * an open corner's `git worktree` registration stores absolute paths, so
   * relocating a live Room's directory would silently break it.
   */
  private roomRoot(channelId: string, room?: RoomRuntimeRecord): string {
    return room?.root ?? resolve(dirname(this.configPath), 'rooms', channelId);
  }

  /**
   * Per-room harness state directory, or undefined to keep the daemon's
   * ambient state (see `agent-home.ts`).
   *
   * Migration rule: a Room directory that already exists predates per-room
   * homes, so silently re-homing it would strand whatever per-project state
   * its harness had built up. Such Rooms keep the shared state until an
   * operator opts in with `BUZZY_BODY_ROOM_HOME=1`; every new Room is isolated
   * from the start. The marker directory is created here (not lazily on first
   * activation) so the decision is stable across daemon restarts.
   */
  private roomAgentHomeRoot(workspaceRoot: string): string | undefined {
    const flag = process.env.BUZZY_BODY_ROOM_HOME;
    if (flag === '0') return undefined;
    const home = resolve(workspaceRoot, 'agent-home');
    if (flag !== '1' && !existsSync(home) && existsSync(workspaceRoot)) return undefined;
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.error(`[supervisor] per-room agent home unavailable at ${home}:`, error);
      return undefined;
    }
    return home;
  }

  private roomBodyConfig(workspaceRoot: string): BodyConfig {
    const agentHomeRoot = this.roomAgentHomeRoot(workspaceRoot);
    return {
      ...this.baseConfig,
      workspaceRoot,
      ...(agentHomeRoot ? { agentHomeRoot } : {}),
    };
  }

  private startRepositoryRoom(room: RoomRuntimeRecord, channelId = room.channelId): void {
    const controller = new AbortController();
    const workspaceRoot = this.roomRoot(channelId, room);
    const config: BodyConfig = this.roomBodyConfig(workspaceRoot);
    const startedAt = this.now();
    const health = {
      poll: () => this.notePoll(channelId),
      failure: (_roomId: string, retryInMs: number) => this.notePollFailure(channelId, retryInMs),
      presence: (_roomId: string, status: 'online' | 'offline') =>
        this.notePresence(channelId, status),
    };
    const body = new Body(
      config,
      runtimeIdentity(this.runtime.body),
      this.agent,
      room.mergeWorker ? runtimeIdentity(room.mergeWorker) : undefined,
      {
        scheduler: this.scheduler,
        relaySocket: this.relaySocket,
        statePath: resolve(workspaceRoot, 'body-state.json'),
        resolveNamedRepository: (target) => this.resolveNamedRepository(target),
        onRoomPollSuccess: health.poll,
        onRoomPollFailure: health.failure,
        onRoomPresence: health.presence,
      },
    );
    const promise = body
      .runRepositoryRoomLoop(this.runtime.communityId, channelId, boundRepoFromRoom(room), {
        signal: controller.signal,
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error(`[supervisor] Room ${channelId} quarantined:`, error);
        }
      })
      .finally(async () => {
        await body.dispose();
        if (this.running.get(channelId)?.body === body) this.running.delete(channelId);
      });
    this.running.set(channelId, {
      body,
      controller,
      promise,
      lastPollAt: startedAt,
      lastPresenceAt: startedAt,
      presence: 'offline',
      backoffUntil: 0,
      recovering: false,
    });
    console.log(`[supervisor] serving Room ${channelId} from ${room.repo.root}`);
  }

  private startConversationRoom(
    channelId: string,
    kind: 'named-repository' | 'direct-message',
  ): void {
    const controller = new AbortController();
    const workspaceRoot = this.roomRoot(channelId);
    const config: BodyConfig = this.roomBodyConfig(workspaceRoot);
    const startedAt = this.now();
    const body = new Body(config, runtimeIdentity(this.runtime.body), this.agent, undefined, {
      scheduler: this.scheduler,
      relaySocket: this.relaySocket,
      statePath: resolve(workspaceRoot, 'body-state.json'),
      resolveNamedRepository: (target) => this.resolveNamedRepository(target),
      onRoomPollSuccess: () => this.notePoll(channelId),
      onRoomPollFailure: (_roomId, retryInMs) => this.notePollFailure(channelId, retryInMs),
      onRoomPresence: (_roomId, status) => this.notePresence(channelId, status),
    });
    const promise = body
      .runConversationRoomLoop(channelId, kind, { signal: controller.signal })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error(`[supervisor] Room ${channelId} quarantined:`, error);
        }
      })
      .finally(async () => {
        await body.dispose();
        if (this.running.get(channelId)?.body === body) this.running.delete(channelId);
      });
    this.running.set(channelId, {
      body,
      controller,
      promise,
      lastPollAt: startedAt,
      lastPresenceAt: startedAt,
      presence: 'offline',
      backoffUntil: 0,
      recovering: false,
    });
    console.log(
      `[supervisor] serving ${kind === 'direct-message' ? 'read-only DM' : 'repo-less Room'} ${channelId}`,
    );
  }

  private resolveNamedRepository(target: NamedRepositoryTarget): Promise<BoundRepo> {
    const existing = this.namedRepositoryResolutions.get(target.id);
    if (existing) return existing;
    const resolution = this.materializeNamedRepository(target).finally(() => {
      if (this.namedRepositoryResolutions.get(target.id) === resolution) {
        this.namedRepositoryResolutions.delete(target.id);
      }
    });
    this.namedRepositoryResolutions.set(target.id, resolution);
    return resolution;
  }

  private async materializeNamedRepository(target: NamedRepositoryTarget): Promise<BoundRepo> {
    const repositories = resolve(dirname(this.configPath), 'repositories');
    const key = createHash('sha256')
      .update(`${target.kind}:${target.relayOwnerHex ?? target.owner}/${target.repo}`)
      .digest('hex');
    const root = resolve(repositories, `named-${key}`);
    await mkdir(repositories, { recursive: true, mode: 0o700 });
    if (!existsSync(root)) {
      const result = target.relayOwnerHex
        ? gitAuthed(repositories, this.agent, target.relayOwnerHex, target.repo, [
            'clone',
            `${this.runtime.relayBaseUrl}/git/${target.relayOwnerHex}/${target.repo}`,
            root,
          ])
        : gitWithUserCredentials(repositories, [
            'clone',
            `https://github.com/${target.owner}/${target.repo}.git`,
            root,
          ]);
      if (!result.ok) {
        console.error(
          `[supervisor] named repository clone failed for ${target.id}:`,
          result.stderr,
        );
        throw new Error(
          `repository ${target.id} could not be cloned or accessed with the available credentials`,
        );
      }
    }

    let local: LocalRepositoryBinding;
    try {
      local = inspectLocalRepository(root);
    } catch (error) {
      console.error(`[supervisor] named repository inspection failed for ${target.id}:`, error);
      throw new Error(`repository ${target.id} could not be verified after cloning`);
    }
    const matchesTarget = target.relayOwnerHex
      ? local.relayRepo?.ownerHex === target.relayOwnerHex && local.relayRepo.repo === target.repo
      : local.repository.remote === `git://github.com/${target.owner}/${target.repo}`;
    if (!matchesTarget) {
      throw new Error(`repository clone did not match the approved target ${target.id}`);
    }
    return {
      repo: target.repo,
      ...(target.relayOwnerHex ? { ownerHex: target.relayOwnerHex } : {}),
      targetBranch: `refs/heads/${local.targetBranch}`,
      localPath: local.root,
      ...(local.remoteName ? { remoteName: local.remoteName } : {}),
      repositoryKey: local.repository.key,
      localOnly: false,
      repositoryId: target.id,
    };
  }

  private async materializeRoom(
    channelId: string,
    membershipSince: number,
    binding: RepositoryBinding,
  ): Promise<RoomRuntimeRecord> {
    if (binding.localOnly) {
      throw new Error(`invited Room ${channelId} is local-only on another checkout`);
    }
    const repositories = resolve(dirname(this.configPath), 'repositories');
    const root = resolve(repositories, binding.key);
    await mkdir(repositories, { recursive: true, mode: 0o700 });
    if (!existsSync(root)) {
      const relayRepo = relayRepoFromBinding(binding);
      const result = relayRepo
        ? gitAuthed(repositories, this.agent, relayRepo.ownerHex, relayRepo.repo, [
            'clone',
            `${this.runtime.relayBaseUrl}/git/${relayRepo.ownerHex}/${relayRepo.repo}`,
            root,
          ])
        : gitWithUserCredentials(repositories, ['clone', cloneUrl(binding), root]);
      if (!result.ok)
        throw new Error(`could not clone invited Room ${channelId}: ${result.stderr}`);
    }
    const local = inspectLocalRepository(root);
    if (local.repository.key !== binding.key) {
      throw new Error(`invited Room ${channelId} repository binding mismatch`);
    }
    const relayRepo = relayRepoFromBinding(binding);
    const repo: LocalRepositoryBinding = {
      ...local,
      ...(relayRepo ? { relayRepo } : {}),
    };
    return {
      channelId,
      repo,
      // Stamp the storage root explicitly so this Room stays put even if the
      // runtime record later moves.
      root: this.roomRoot(channelId),
      membershipSince,
      discoveredAt: new Date().toISOString(),
    };
  }

  private async stopAll(): Promise<void> {
    const rooms = [...this.running.values()];
    for (const room of rooms) room.controller.abort();
    await Promise.all(rooms.map((room) => room.promise.catch(() => undefined)));
  }

  private notePoll(channelId: string): void {
    const running = this.running.get(channelId);
    if (running) {
      running.lastPollAt = this.now();
      running.backoffUntil = 0;
    }
  }

  private notePollFailure(channelId: string, retryInMs: number): void {
    const running = this.running.get(channelId);
    if (running) running.backoffUntil = Math.max(running.backoffUntil, this.now() + retryInMs);
  }

  private notePresence(channelId: string, status: 'online' | 'offline'): void {
    const running = this.running.get(channelId);
    if (!running) return;
    running.lastPresenceAt = this.now();
    running.presence = status;
  }

  /**
   * A Room is healthy only when it is both still polling and successfully
   * refreshing presence. Recover just that Room when either signal goes stale;
   * sibling Bodies and the shared Workspace supervisor keep serving normally.
   */
  private async watchdog(): Promise<void> {
    const now = this.now();
    for (const [channelId, running] of this.running) {
      if (running.recovering) continue;
      // Poll failure is an expected, Room-local degraded state. Do not turn a
      // relay-directed wait into a fresh aggressive generation before it ends.
      if (now <= running.backoffUntil) continue;
      const pollAge = now - running.lastPollAt;
      const presenceAge = now - running.lastPresenceAt;
      if (pollAge <= this.watchdogStaleMs && presenceAge <= this.watchdogStaleMs) continue;
      running.recovering = true;
      console.error(
        `[supervisor] Room ${channelId} watchdog recovery: ` +
          `pollAge=${pollAge}ms presenceAge=${presenceAge}ms presence=${running.presence}`,
      );
      // forceSuspend kills a stuck ACP request; AbortController exits the Room
      // loop once its bounded relay request returns. reconcile starts a fresh
      // Body generation on its next control-plane pass.
      await running.body
        .forceRecoverRoom(channelId)
        .catch((error) =>
          console.error(`[supervisor] Room ${channelId} watchdog ACP cleanup failed:`, error),
        );
      running.controller.abort();
    }
  }
}
