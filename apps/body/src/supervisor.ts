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
  type RoomRepository,
} from '@beeline/buzz-client';
import { git, gitAuthed, gitWithUserCredentials, type Identity } from '@beeline/gate';
import { Body, type BoundRepo } from './body.js';
import { postAgentMessage } from './activity.js';
import { AGENT_ERROR_STATE_MESSAGES } from './agent-state-messages.js';
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
  /** Repository resolved from Room state for a not-yet-materialized Room. */
  roomRepository?: RoomRepository;
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

/**
 * How long one Room that cannot be joined is left alone before discovery tries
 * it again.
 *
 * A Room can be unservable for a perfectly legitimate, durable reason — the
 * observed one is a Room bound to a local-only repository that lives on
 * another checkout entirely, which no amount of retrying will change on this
 * host. Such a failure used to escape `reconcile()` and put the whole
 * discovery pass on the 5s error backoff forever, which both spammed the log
 * and starved every *other* invited Room of its join. It is now handled per
 * Room, on this much longer cadence, so an operator fixing the underlying
 * cause is still picked up without polling a known-bad Room every few seconds.
 */
export const DEFAULT_ROOM_DISCOVERY_RETRY_MS = 10 * 60_000;

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
  /** Rooms already notified their repo can't be materialized — one notice per
   *  transition into that state, not once per reconcile retry. */
  private readonly repoUnavailableNotified = new Set<string>();
  /**
   * Rooms whose join failed, keyed by channel id: when to try again, and the
   * last message logged for them. One unservable Room must cost exactly one
   * log line and its own retry cadence — never the whole discovery pass.
   */
  private readonly roomDiscoveryFailures = new Map<
    string,
    { retryAt: number; message: string }
  >();
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

  /**
   * The last classification this daemon actually CONFIRMED for a Room, so an
   * unconfirmable read can carry it forward instead of downgrading the Room.
   */
  private readonly lastRoomClassification = new Map<string, DesiredChannel>();
  /** De-dupe the unverified log to one line per Room per reason. */
  private readonly roomRepositoryUnverified = new Map<string, string>();

  private noteRoomRepositoryUnverified(channelId: string, reason: string): void {
    if (this.roomRepositoryUnverified.get(channelId) === reason) return;
    this.roomRepositoryUnverified.set(channelId, reason);
    console.warn(
      `[supervisor] Room ${channelId} repository could not be confirmed (${reason}); ` +
        'keeping the last confirmed classification rather than treating it as repo-less',
    );
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
        // The repository belongs to the ROOM, resolved from published Room
        // state (admin-authored config → immutable genesis binding), not from
        // this agent's own pairing binding — any agent joining the Room trees
        // off the same repo.
        const resolution = await client.resolveRoomRepositoryState(channelId);
        if (resolution.kind === 'repository') {
          const entry: DesiredChannel = {
            membershipSince: membership.event.created_at,
            kind: 'repository',
            roomRepository: resolution.repository,
          };
          this.lastRoomClassification.set(channelId, entry);
          desired.set(channelId, entry);
          continue;
        }
        // "Could not confirm" must never become "there isn't one". A Room's
        // repository config is authorized against the CURRENT admin
        // projection, and that read comes back empty under relay load — which
        // used to silently reclassify a live repository Room as a repo-less
        // one, mid-session, so its own agent then told the admin the Room had
        // no repository linked. Carry the last confirmed answer instead, and
        // if there has never been one, leave the Room alone this pass rather
        // than starting it as something it may not be.
        if (resolution.kind === 'unverified') {
          const known = this.lastRoomClassification.get(channelId);
          if (known) {
            desired.set(channelId, { ...known, membershipSince: membership.event.created_at });
          } else if (this.running.has(channelId)) {
            desired.set(channelId, {
              membershipSince: membership.event.created_at,
              kind: 'named-repository',
            });
          }
          this.noteRoomRepositoryUnverified(channelId, resolution.reason);
          continue;
        }
        const dm = await client.getDirectMessage(channelId);
        const entry: DesiredChannel = {
          membershipSince: membership.event.created_at,
          kind:
            dm && dm.participants.includes(this.agent.publicKey)
              ? 'direct-message'
              : 'named-repository',
        };
        this.lastRoomClassification.set(channelId, entry);
        desired.set(channelId, entry);
      }

      for (const [channelId, running] of [...this.running]) {
        if (desired.has(channelId)) continue;
        // Stop intake first. Body drains accepted turns before dispose returns.
        running.controller.abort();
        await running.promise.catch(() => undefined);
      }

      for (const [channelId, target] of desired) {
        if (this.running.has(channelId)) continue;
        // One Room that cannot be joined is a fact about that Room, not about
        // discovery. Isolate it here: a throw used to abort the whole pass,
        // so a single unservable Room (a local-only repo bound on another
        // checkout is the observed case) both starved every Room behind it in
        // this loop of its join and pinned discovery to the 5s error backoff
        // forever.
        const failure = this.roomDiscoveryFailures.get(channelId);
        if (failure && this.now() < failure.retryAt) continue;
        try {
          if (target.kind === 'repository') {
            let room = this.runtime.rooms.find((candidate) => candidate.channelId === channelId);
            if (!room) {
              const roomRepository =
                target.roomRepository ?? (await client.resolveRoomRepository(channelId));
              if (roomRepository) {
                // Materialize the ONE shared per-repo-per-host checkout eagerly,
                // on join — the Room's read-only session reads code from it
                // (list/read/search/git-log) before any corner is opened.
                room = await this.materializeRoom(
                  channelId,
                  target.membershipSince,
                  roomRepository,
                );
                this.runtime.rooms.push(room);
                await writeRuntimeRecord(this.runtime);
              } else {
                room = target.repositoryRoom;
              }
            }
            if (room) await this.startRepositoryRoom(room, channelId);
          } else {
            this.startConversationRoom(channelId, target.kind);
          }
          this.roomDiscoveryFailures.delete(channelId);
        } catch (error) {
          this.noteRoomDiscoveryFailure(channelId, error);
        }
      }
      return true;
    } finally {
      client.disconnect();
    }
  }

  /**
   * Record one Room's join failure without letting it reach the discovery
   * pass. The Room is parked for `DEFAULT_ROOM_DISCOVERY_RETRY_MS`, and the
   * console line is emitted only when the reason changed — a Room that is
   * durably unservable (a local-only repository bound on another checkout)
   * says so once, not every pass.
   */
  private noteRoomDiscoveryFailure(channelId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const previous = this.roomDiscoveryFailures.get(channelId);
    this.roomDiscoveryFailures.set(channelId, {
      retryAt: this.now() + DEFAULT_ROOM_DISCOVERY_RETRY_MS,
      message,
    });
    if (previous?.message === message) return;
    console.error(
      `[supervisor] Room ${channelId} could not be joined; skipping it and retrying in ` +
        `${DEFAULT_ROOM_DISCOVERY_RETRY_MS}ms:`,
      error,
    );
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

  private async startRepositoryRoom(
    room: RoomRuntimeRecord,
    channelId = room.channelId,
  ): Promise<void> {
    // Serve from beeline's OWN dedicated canonical checkout, never the
    // operator's working tree. The operator's checkout carries their WIP and
    // can drift (the confirmed leak where the agent shared it); the agent must
    // read clean origin state and never touch the operator's tree.
    let boundRepo: BoundRepo;
    try {
      boundRepo = await this.resolveServingRepo(room);
      this.repoUnavailableNotified.delete(channelId);
    } catch (error) {
      // A room whose canonical checkout cannot be materialized cannot be
      // served yet. Leave it unstarted; the next reconcile retries.
      console.error(
        `[supervisor] Room ${channelId} canonical checkout unavailable; will retry:`,
        error,
      );
      // The Room itself never went silent on the daemon's console before —
      // now it says so once, instead of just never coming alive.
      if (!this.repoUnavailableNotified.has(channelId)) {
        this.repoUnavailableNotified.add(channelId);
        postAgentMessage(channelId, this.agent, AGENT_ERROR_STATE_MESSAGES['repo-unavailable']).catch(
          (publishError) =>
            console.error(
              `[supervisor] failed to publish repo-unavailable notice for Room ${channelId}:`,
              publishError,
            ),
        );
      }
      return;
    }
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
      .runRepositoryRoomLoop(this.runtime.communityId, channelId, boundRepo, {
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
    console.log(`[supervisor] serving Room ${channelId} from ${boundRepo.localPath}`);
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
    const repositories = this.sharedRepositoriesRoot();
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

  /**
   * The ONE shared canonical checkout root for this host — NOT per-agent and
   * NOT per-room. Every agent/room/corner for a given repo on this host trees
   * off a single checkout of it under here, keyed by repository key.
   *
   * Deliberately anchored on the machine-local `supervisorRoot`, not on
   * `dirname(this.configPath)` (which is per-agent): a second agent paired on
   * the same host resolves the identical path and reuses the first agent's
   * clone instead of materializing its own.
   */
  private sharedRepositoriesRoot(): string {
    return resolve(this.runtime.supervisorRoot, 'beeline', 'repositories');
  }

  /** Absolute path of this host's dedicated canonical checkout for a repo key. */
  private canonicalCheckoutPath(repositoryKey: string): string {
    return resolve(this.sharedRepositoriesRoot(), repositoryKey);
  }

  /**
   * Ensure beeline's OWN dedicated canonical checkout of a repository exists
   * and tracks clean origin state, and return it as a `LocalRepositoryBinding`
   * rooted there. NEVER the operator's working tree: that tree carries WIP and
   * drifts (the confirmed operator-checkout leak), so the agent clones its own
   * canonical from origin, keyed by repository key — one per repo per host,
   * shared by every agent/room/corner, never per-agent or per-room.
   *
   * The binding IDENTITY (key/name/localOnly) is preserved from the caller's
   * `binding`; only the checkout root and branch state are (re)materialized.
   */
  private async ensureCanonicalCheckout(input: {
    binding: RepositoryBinding;
    relayRepo?: { ownerHex: string; repo: string };
    targetBranch?: string;
  }): Promise<LocalRepositoryBinding> {
    const { binding } = input;
    if (binding.localOnly || !binding.remote) {
      throw new Error(`repository ${binding.name} has no remote to clone a canonical checkout from`);
    }
    const relayRepo = input.relayRepo ?? relayRepoFromBinding(binding);
    const repositories = this.sharedRepositoriesRoot();
    const root = this.canonicalCheckoutPath(binding.key);
    await mkdir(repositories, { recursive: true, mode: 0o700 });
    if (!existsSync(root)) {
      const result = relayRepo
        ? gitAuthed(repositories, this.agent, relayRepo.ownerHex, relayRepo.repo, [
            'clone',
            `${this.runtime.relayBaseUrl}/git/${relayRepo.ownerHex}/${relayRepo.repo}`,
            root,
          ])
        : gitWithUserCredentials(repositories, ['clone', cloneUrl(binding), root]);
      if (!result.ok) {
        throw new Error(`could not clone canonical checkout for ${binding.name}: ${result.stderr}`);
      }
    }
    const local = inspectLocalRepository(root);
    if (local.repository.key !== binding.key) {
      throw new Error(`canonical checkout for ${binding.name} has a mismatched binding key`);
    }
    // Track clean origin state and pin the working tree to the target branch,
    // so the read-only session reads exactly what origin holds — never WIP.
    // Best-effort: corners use separate `git worktree` trees, so this never
    // fights their edits, and every Room of one repo shares one target branch.
    const target = input.targetBranch ?? local.targetBranch;
    if (local.remoteName) {
      const fetchResult = relayRepo
        ? gitAuthed(root, this.agent, relayRepo.ownerHex, relayRepo.repo, ['fetch', local.remoteName])
        : gitWithUserCredentials(root, ['fetch', local.remoteName]);
      const remoteRef = `refs/remotes/${local.remoteName}/${target}`;
      if (fetchResult.ok && git(root, ['rev-parse', '--verify', remoteRef]).ok) {
        git(root, ['checkout', '-q', target]);
        git(root, ['reset', '--hard', remoteRef]);
      }
    } else if (target !== local.targetBranch) {
      git(root, ['checkout', '-q', target]);
    }
    // Preserve the room's binding identity; only the root/branch are canonical.
    return {
      ...local,
      repository: binding,
      ...(target ? { targetBranch: target } : {}),
      ...(relayRepo ? { relayRepo } : {}),
    };
  }

  /**
   * The repository this daemon actually serves a Room from: beeline's dedicated
   * canonical checkout for a remote repo, or (only for a non-convergent
   * local-only repo, which has no origin to clone) the stored binding as-is.
   */
  private async resolveServingRepo(room: RoomRuntimeRecord): Promise<BoundRepo> {
    if (room.repo.repository.localOnly) return boundRepoFromRoom(room);
    const canonical = await this.ensureCanonicalCheckout({
      binding: room.repo.repository,
      ...(room.repo.relayRepo ? { relayRepo: room.repo.relayRepo } : {}),
      ...(room.repo.targetBranch ? { targetBranch: room.repo.targetBranch } : {}),
    });
    return {
      ...boundRepoFromRoom(room),
      localPath: canonical.root,
      remoteName: canonical.remoteName ?? 'origin',
      // The operator's own tree, kept only when it is genuinely a DIFFERENT
      // directory from the one this Room is served out of. That is the
      // three-git-realities gap a land recap has to be able to name: the
      // commit is on the remote and in the canonical checkout, and the person
      // reading is looking at neither. `boundRepoFromRoom`'s `localPath` is
      // overwritten just above, so this is the last point where the original
      // is still known.
      ...(room.repo.root && room.repo.root !== canonical.root
        ? { operatorCheckout: room.repo.root }
        : {}),
      ...(canonical.targetBranch
        ? { targetBranch: `refs/heads/${canonical.targetBranch}` }
        : {}),
    };
  }

  /**
   * Materialize a newly-discovered Room by resolving its repository to the one
   * dedicated per-host canonical checkout. Called on join (during reconcile),
   * before the Room's read-only session ever runs, so pre-corner code reading
   * has a real checkout to read.
   */
  private async materializeRoom(
    channelId: string,
    membershipSince: number,
    roomRepository: RoomRepository,
  ): Promise<RoomRuntimeRecord> {
    const binding = roomRepository.binding;
    if (binding.localOnly) {
      throw new Error(`invited Room ${channelId} is local-only on another checkout`);
    }
    const local = await this.ensureCanonicalCheckout({
      binding,
      ...(relayRepoFromBinding(binding) ? { relayRepo: relayRepoFromBinding(binding)! } : {}),
      ...(roomRepository.targetBranch ? { targetBranch: roomRepository.targetBranch } : {}),
    });
    return {
      channelId,
      repo: local,
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
