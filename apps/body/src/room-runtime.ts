import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';
import {
  type AgentSoulProfile,
  type BuzzClient,
  createBuzzClient,
  type RepositoryBinding,
  type RoomRepository,
} from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import { git, gitAuthed, type GitResult, type Identity } from '@beeline/gate';
import { Body, type BoundRepo, type RoomEditPolicy } from './body.js';
import type { ScheduledTurnRequest } from './work-calendar.js';
import type { BodyConfig } from './config.js';
import type { NamedRepositoryTarget } from './repository-target.js';
import {
  inspectLocalRepositoryBounded,
  runtimeIdentity,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
  type LocalRepositoryBinding,
  type RoomRuntimeRecord,
} from './runtime.js';
import { SharedRelaySocket } from './relay-socket.js';
import { isArchivedChannelError } from './archived-channel.js';
import {
  RepositoryTruthResolver,
  type RepositoryTruth,
  type RepositoryTruthCheckpoint,
} from './repository-truth.js';
import { GitHubAppRuntime } from './github-app.js';
import {
  DEFAULT_WORKSPACE_LIVE_SESSIONS_FLOOR,
  resolvePerRoomLiveSessions,
  SessionScheduler,
} from './session-scheduler.js';
import { RoomQuarantineStateMachine } from './room-quarantine.js';

interface RunningRoom {
  body: Body;
  boundRepo?: BoundRepo;
  editPolicy: RoomEditPolicy;
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

/** Leave the rest of systemd's cleanup reserve intact if the relay is wedged. */
const FORCED_UPDATE_NOTICE_TIMEOUT_MS = 5_000;

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

function sameRepositoryBinding(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return (
    left.key === right.key &&
    left.name === right.name &&
    left.remote === right.remote &&
    left.localOnly === right.localOnly &&
    left.githubInstallationId === right.githubInstallationId
  );
}

function boundRepoFromTruth(truth: RepositoryTruth, room?: RoomRuntimeRecord): BoundRepo {
  return {
    truth,
    repo: truth.relayRepo?.repo ?? truth.binding.name,
    ...(truth.relayRepo ? { ownerHex: truth.relayRepo.ownerHex } : {}),
    targetBranch: `refs/heads/${truth.targetBranch}`,
    localPath: truth.checkoutPath,
    ...(truth.remoteName ? { remoteName: truth.remoteName } : {}),
    ...(truth.remoteUrl ? { remoteUrl: truth.remoteUrl } : {}),
    repositoryKey: truth.binding.key,
    localOnly: truth.kind === 'local',
    ...(room ? {} : { repositoryId: truth.binding.name }),
  };
}

export function reconcileRetryMs(error: unknown, pollMs: number): number {
  const match = String(error).match(/retry in\s+(\d+)s/i);
  return match ? Math.max(pollMs, (Number(match[1]) + 1) * 1_000) : pollMs;
}

/**
 * The relay's authoritative, terminal verdict that a channel is archived.
 *
 * Observed verbatim as a Room-serving failure:
 * `publishEvent kind=9 failed: HTTP 400 {"error":"invalid: channel is archived"}`.
 * A signed event has a stable id and an archived channel accepts no writes,
 * so re-serving the Room can only produce the identical refusal — this is a
 * fact about the Room, not a transient transport condition, and it must never
 * be retried on a loop.
 *
 * The classifier's canonical home is `archived-channel.ts` (body imports it
 * too, and supervisor already imports body, so body cannot import it from
 * here); re-exported for this module's Room-quarantine callers.
 */
export { isArchivedChannelError };

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

/**
 * Retry cadence for a Room whose join failed for a TRANSIENT reason.
 *
 * The production darkness of 2026-08-23 did not end when the relay came back:
 * the outage had first gotten a Room's push loop watchdog-recycled, and the
 * recovery join then failed on a transient authority error
 * (`repository_not_granted` from the auth service, itself mid-rollout), which
 * parked the Room here for ten minutes — repeatedly, across successive deploy
 * windows. The daemon process stayed up the whole time; the agent was simply
 * gone from every Room. A transport-shaped failure must therefore retry on
 * the short cadence below, not the long one.
 */
export const DEFAULT_ROOM_DISCOVERY_TRANSIENT_RETRY_MS = 30_000;

const ROOM_JOIN_NOTICE_TAG = 'buzz-agent-room-join-notice';
const ROOM_JOIN_NOTICE_QUERY_LIMIT = 20;
const ROOM_JOIN_UNAVAILABLE_STATUS = 'repository-unavailable';
const ROOM_JOIN_RECOVERED_STATUS = 'repository-recovered';
const ROOM_JOIN_FAILURE_PREFIX = "Agent unavailable: I could not access this Room's repository.";
const ROOM_JOIN_RECOVERY_TEXT =
  'Agent available again: repository access recovered and this Room is ready.';

function hasEventTag(event: NostrEvent, name: string, value: string): boolean {
  return event.tags.some((tag) => tag[0] === name && tag[1] === value);
}

function compareEvents(left: NostrEvent, right: NostrEvent): number {
  return left.created_at - right.created_at || left.id.localeCompare(right.id);
}

/**
 * Known-DURABLE join failures keep the long park.
 *
 * Everything else is treated as transient and retried short: the cost of a
 * wrong guess is one failed join attempt per pass against a Room the daemon
 * cannot serve anyway, whereas the cost of parking a recoverable Room for ten
 * minutes is the agent visibly disappearing. Matched on the reason text so no
 * error-type import is needed.
 */
export function isDurableRoomJoinFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /local-only on another checkout|channel is archived/i.test(text);
}

/**
 * The Room's repository binding names a repository the Beeline GitHub App
 * does not cover yet: only the repository's OWNER can install the App, so the
 * daemon parks the Room (transient retry) until that grant lands. The typed
 * auth refusal carries a shareable install URL; this matcher only decides
 * whether a later successful join deserves its "link went live" card.
 */
export function isOwnerGrantNeededFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /owner_grant_needed|waiting for its owner to grant beeline access/i.test(text);
}

/**
 * A destructive removal needs repeated, successful agreement from the relay.
 * One empty projection is not enough: an edge/cache cutover can return a
 * valid-but-incomplete answer immediately after a failed query.
 */
export const REMOVAL_CONFIRMATION_READS = 3;
export const ROOM_JOIN_CONCURRENCY = 3;
export const ROOM_RECONCILE_DEADLINE_MS = 75_000;
/** Leave one minute for forced cleanup before systemd's 10-minute stop ceiling. */
export const DEFAULT_DRAIN_DEADLINE_MS = 9 * 60_000;

export async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  const queue = [...values];
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
      for (;;) {
        const value = queue.shift();
        if (value === undefined) return;
        await visit(value);
      }
    }),
  );
}

async function withRoomDeadline<T>(
  roomId: string,
  phase: 'classify' | 'join',
  work: Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Room ${roomId} ${phase} deadline exceeded after ${ROOM_RECONCILE_DEADLINE_MS}ms`,
          ),
        ),
      ROOM_RECONCILE_DEADLINE_MS,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Effective Workspace membership after transport failures and removal
 * corroboration have been accounted for. Callers cannot accidentally treat a
 * failed read as false because `unknown` is a distinct, required case.
 */
export type WorkspaceMembershipStatus = 'member' | 'not-member' | 'unknown';

async function readWorkspaceMembership(
  read: () => Promise<boolean>,
  onUnknown: (error: unknown) => void,
): Promise<WorkspaceMembershipStatus> {
  try {
    return (await read()) ? 'member' : 'not-member';
  } catch (error) {
    onUnknown(error);
    return 'unknown';
  }
}

/**
 * Bounded Room-runtime leaf used by the thin daemon core. It owns Room state,
 * Bodies, repository materialization through the Git worker, and quarantine;
 * it does not own process supervision, READY/WATCHDOG, or update handoff.
 */
export class RoomRuntimeCoordinator {
  private runScheduleNow?: (scheduleId: string) => Promise<{ runId: string; eventId: string }>;
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
  private readonly repositoryTruth: RepositoryTruthResolver;
  private readonly githubApp: GitHubAppRuntime | undefined;
  private readonly namedRepositoryResolutions = new Map<string, Promise<BoundRepo>>();
  private readonly quarantine: RoomQuarantineStateMachine;
  /**
   * Rooms whose durable join-notice state has been checked this process.
   * A failed read/publish is deliberately not cached, so the ordinary
   * reconcile path retries it without a second checker or timer.
   */
  private readonly settledRoomJoinNotices = new Set<string>();
  /** A successful failure publish is relay-visible even before query projection catches up. */
  private readonly publishedRoomJoinFailures = new Map<string, NostrEvent>();
  /**
   * Rooms the relay has authoritatively reported as ARCHIVED, held inert for
   * this daemon process: never served again, never retried, and never even
   * re-asked once the answer is in (the relay's archive verdict is terminal).
   *
   * Held inert rather than forgotten from `runtime.rooms` on purpose: the
   * record is harmless local state, and the RELAY stays the authority on
   * archived-ness. After a daemon restart the join path re-reads relay truth
   * (`getChannelMetadata`) before serving anything, so a Room only ever comes
   * back through a fresh authoritative answer that says it is NOT archived —
   * never silently, and never by our own retry loop.
   */
  private workspaceRemovalConfirmations = 0;
  private readonly roomRemovalConfirmations = new Map<string, number>();
  /** Schedule another short-cadence read while a removal is being confirmed. */
  private confirmationPending = false;
  /**
   * `updatedAt` of the `buzz-agent-soul` overlay last observed for this
   * agent, undefined until the first successful read. That first read only
   * seeds the baseline — a Room freshly discovering its persona is not a
   * "change" — every read after it that disagrees is.
   */
  private lastKnownSoulUpdatedAt: number | undefined;
  private readonly now: () => number;
  private readonly watchdogStaleMs: number;
  private readonly reconcileHeartbeatMs: number;
  private readonly drainDeadlineMs: number;
  private drainDeadlineAt: number | undefined;

  constructor(
    runtime: AgentRuntimeRecord,
    configPath: string,
    baseConfig: BodyConfig,
    options: {
      now?: () => number;
      watchdogStaleMs?: number;
      reconcileHeartbeatMs?: number;
      drainDeadlineMs?: number;
      relaySocket?: SharedRelaySocket;
    } = {},
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
      perRoomLiveSessions: resolvePerRoomLiveSessions(process.env),
      workspaceFloor: Number(
        process.env.BUZZY_BODY_MAX_SESSIONS_FLOOR ?? String(DEFAULT_WORKSPACE_LIVE_SESSIONS_FLOOR),
      ),
      activeRoomCount: () => this.running.size,
      idleMs: Number(process.env.BUZZY_BODY_SESSION_IDLE_MS ?? String(5 * 60_000)),
      reserveInteractiveSlot: true,
    });
    this.relaySocket =
      options.relaySocket ??
      new SharedRelaySocket({
        baseUrl: runtime.relayBaseUrl,
        ...(runtime.relayHost ? { host: runtime.relayHost } : {}),
        ...(baseConfig.relayWsUrl ? { wsUrl: baseConfig.relayWsUrl } : {}),
        identity: this.agent,
        WebSocketImpl: WebSocket,
      });
    this.githubApp = GitHubAppRuntime.fromEnvironment(process.env, {
      baseUrl: runtime.relayBaseUrl,
      identity: this.agent,
    });
    this.repositoryTruth = new RepositoryTruthResolver({
      repositoriesRoot: this.sharedRepositoriesRoot(),
      relayBaseUrl: runtime.relayBaseUrl,
      agent: this.agent,
      syncOperatorCheckout: process.env.BUZZY_BODY_SYNC_OPERATOR_CHECKOUT === '1',
      ...(this.githubApp
        ? {
            resolveRemoteIdentity: (binding: RepositoryBinding, roomId?: string) =>
              binding.remote?.startsWith('git://github.com/')
                ? this.githubApp!.resolveIdentity(binding, roomId)
                : Promise.resolve(undefined),
            runRemoteGit: (
              cwd: string,
              args: string[],
              binding: RepositoryBinding,
              roomId?: string,
            ) => {
              if (binding.remote?.startsWith('git://github.com/')) {
                return this.githubApp!.git(cwd, args, binding, roomId);
              }
              const relay = relayRepoFromBinding(binding);
              return relay
                ? gitAuthed(cwd, this.agent, relay.ownerHex, relay.repo, args)
                : git(cwd, args);
            },
          }
        : {}),
    });
    this.now = options.now ?? Date.now;
    this.quarantine = new RoomQuarantineStateMachine({
      now: this.now,
      onTransition: (previous, next) => {
        console.error(
          `[thin-core] Room ${next.roomId} could not be joined: state ` +
            `${previous?.kind ?? 'unseen'} -> ${next.kind}: ${next.reason}`,
        );
      },
    });
    this.watchdogStaleMs =
      options.watchdogStaleMs ??
      Number(process.env.BUZZY_BODY_ROOM_WATCHDOG_STALE_MS ?? DEFAULT_ROOM_WATCHDOG_STALE_MS);
    this.reconcileHeartbeatMs =
      options.reconcileHeartbeatMs ??
      Number(process.env.BUZZY_BODY_RECONCILE_HEARTBEAT_MS ?? DEFAULT_RECONCILE_HEARTBEAT_MS);
    this.drainDeadlineMs = options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
  }

  activeRoomIds(): string[] {
    return [...this.running.keys()].sort();
  }

  activeRoomCount(): number {
    return this.running.size;
  }

  async currentPrincipalCanDrive(
    roomId: string,
    workspaceId: string,
    principalPubkey: string,
  ): Promise<boolean | undefined> {
    const room = this.running.get(roomId);
    return room?.body.currentPrincipalCanDrive(workspaceId, principalPubkey);
  }

  async dispatchScheduledTurn(
    request: ScheduledTurnRequest,
    beforeModelActivation: () => Promise<void>,
  ): Promise<void> {
    const room = this.running.get(request.roomId);
    if (!room) throw new Error('scheduled Room is not active');
    await room.body.dispatchScheduledTurn(
      request,
      room.boundRepo,
      room.editPolicy,
      beforeModelActivation,
    );
  }

  setScheduleRunNow(
    run: (scheduleId: string) => Promise<{ runId: string; eventId: string }>,
  ): void {
    this.runScheduleNow = run;
  }

  needsFastReconcile(): boolean {
    return this.confirmationPending;
  }

  reconcileHeartbeatIntervalMs(): number {
    return this.reconcileHeartbeatMs;
  }

  async watchdogTick(): Promise<void> {
    await this.watchdog();
  }

  async shutdown(): Promise<void> {
    await this.stopAll();
    await this.scheduler.dispose();
  }

  /** Tighten shutdown to a handoff's persisted wall-clock deadline. */
  setDrainDeadlineAt(deadlineAt: number): void {
    if (!Number.isFinite(deadlineAt)) return;
    this.drainDeadlineAt = Math.min(this.drainDeadlineAt ?? Number.POSITIVE_INFINITY, deadlineAt);
  }

  /**
   * True when no Room this daemon serves is mid-work. The self-update busy
   * gate (`self-update.ts`) polls this before restarting the daemon; it reads
   * each Room Body's own turn state (`Body.isBusy` — the same state the
   * queued-steer ack already trusts) and is a purely local read, so polling
   * it costs no relay traffic.
   */
  isWorkspaceIdle(): boolean {
    for (const room of this.running.values()) {
      if (typeof room.body.isBusy === 'function' && room.body.isBusy()) return false;
    }
    return true;
  }

  /** Atomically prove idle and close Room intake before handoff can race a new turn. */
  quiesceForUpdateIfIdle(): boolean {
    if (!this.isWorkspaceIdle()) return false;
    for (const room of this.running.values()) room.controller.abort();
    return true;
  }

  /** Record the bounded forced-update state before any active ACP run is cancelled. */
  async prepareForForcedUpdateRestart(): Promise<void> {
    const rooms = [...this.running.entries()];
    const notices = rooms.map(([channelId, room]) =>
      typeof room.body.isBusy === 'function' && room.body.isBusy()
        ? room.body.prepareForForcedUpdateRestart(channelId)
        : Promise.resolve(),
    );
    // Every Body sets its forced-update flag synchronously before its notice
    // publish awaits. Abort intake only after those flags exist, so an event
    // already queued on the socket remains retryable if cancellation wins.
    for (const [, room] of rooms) room.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    const noticeDeadline = new Promise<void>((resolveDeadline) => {
      timer = setTimeout(resolveDeadline, FORCED_UPDATE_NOTICE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.allSettled(notices).then(() => undefined), noticeDeadline]);
    } finally {
      if (timer) clearTimeout(timer);
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
      `[thin-core] Room ${channelId} repository could not be confirmed (${reason}); ` +
        'keeping the last confirmed classification rather than treating it as repo-less',
    );
  }

  /**
   * Detect a newer `buzz-agent-soul` overlay for this agent and, when found,
   * force every session in every Room this daemon serves back through full
   * activation on its next turn (`Body.refreshPersonaForSoulUpdate`). Piggy-
   * backs on the reconcile heartbeat rather than opening a dedicated
   * subscription — the same cadence a saved model/access-policy change
   * already rides.
   */
  private async refreshPersonaIfSoulChanged(client: BuzzClient): Promise<void> {
    let profile: AgentSoulProfile | undefined;
    try {
      const agents = await client.listAgents(this.runtime.communityId);
      profile = agents.find((agent) => agent.pubkey === this.agent.publicKey)?.soulProfile;
    } catch (error) {
      console.error(
        `[thin-core] agent soul freshness check failed for Workspace ` +
          `${this.runtime.communityId}; keeping the currently applied persona:`,
        error,
      );
      return;
    }
    const updatedAt = profile?.updatedAt;
    const previouslyKnown = this.lastKnownSoulUpdatedAt !== undefined;
    const changed = updatedAt !== this.lastKnownSoulUpdatedAt;
    this.lastKnownSoulUpdatedAt = updatedAt;
    if (!previouslyKnown || !changed) return;
    console.info(
      `[thin-core] agent soul changed for Workspace ${this.runtime.communityId}; ` +
        'refreshing persona delivery for every Room session on its next turn',
    );
    await Promise.allSettled(
      [...this.running.values()].map((running) => running.body.refreshPersonaForSoulUpdate()),
    );
  }

  async reconcile(): Promise<WorkspaceMembershipStatus> {
    const client = createBuzzClient({
      baseUrl: this.runtime.relayBaseUrl,
      ...(this.runtime.relayHost ? { host: this.runtime.relayHost } : {}),
      identity: this.agent,
    });
    try {
      this.confirmationPending = false;
      const membership = await readWorkspaceMembership(
        () => client.isMember(this.runtime.communityId, this.agent.publicKey),
        (error) =>
          console.error(
            `[thin-core] Workspace ${this.runtime.communityId} membership could not be ` +
              'confirmed; keeping runtime and Rooms, then retrying:',
            error,
          ),
      );
      if (membership === 'unknown') {
        // Corroboration must be consecutive successful reads. A failed read
        // breaks the sequence and cannot move the daemon closer to teardown.
        this.workspaceRemovalConfirmations = 0;
        this.roomRemovalConfirmations.clear();
        return 'unknown';
      }
      if (membership === 'not-member') {
        this.roomRemovalConfirmations.clear();
        this.workspaceRemovalConfirmations += 1;
        if (this.workspaceRemovalConfirmations < REMOVAL_CONFIRMATION_READS) {
          this.confirmationPending = true;
          console.warn(
            `[thin-core] Workspace ${this.runtime.communityId} membership read says agent is ` +
              `absent (${this.workspaceRemovalConfirmations}/${REMOVAL_CONFIRMATION_READS}); ` +
              'keeping runtime and Rooms until successful reads corroborate removal',
          );
          return 'unknown';
        }
        console.log(
          `[thin-core] agent removal from Workspace ${this.runtime.communityId} corroborated by ` +
            `${REMOVAL_CONFIRMATION_READS} successful reads; draining runtime`,
        );
        return 'not-member';
      }
      this.workspaceRemovalConfirmations = 0;
      const memberships = await client.listMyChannels();
      const desired = new Map<string, DesiredChannel>();
      await mapWithConcurrency(memberships, ROOM_JOIN_CONCURRENCY, async (membership) => {
        const channelId = membership.channelId;
        const membershipSince = membership.event.created_at;
        const knownRoom = this.runtime.rooms.find((candidate) => candidate.channelId === channelId);
        try {
          await withRoomDeadline(
            channelId,
            'classify',
            (async () => {
              // listMyChannels reads the relay's current member/admin
              // projections. Known Rooms need no further identity queries.
              if (knownRoom) {
                const resolution = await client.resolveRoomRepositoryState(channelId);
                desired.set(channelId, {
                  membershipSince,
                  kind: 'repository',
                  repositoryRoom: knownRoom,
                  ...(resolution.kind === 'repository'
                    ? { roomRepository: resolution.repository }
                    : {}),
                });
                if (resolution.kind === 'unverified') {
                  this.noteRoomRepositoryUnverified(channelId, resolution.reason);
                }
                return;
              }
              if ((await client.getChannelCommunityId(channelId)) !== this.runtime.communityId)
                return;
              if (channelId === this.runtime.communityId) return;
              if (await client.getParentChannelId(channelId)) return;
              // The repository belongs to the ROOM, resolved from published
              // Room state rather than this agent's pairing binding.
              const resolution = await client.resolveRoomRepositoryState(channelId);
              if (resolution.kind === 'repository') {
                const entry: DesiredChannel = {
                  membershipSince,
                  kind: 'repository',
                  roomRepository: resolution.repository,
                };
                this.lastRoomClassification.set(channelId, entry);
                desired.set(channelId, entry);
                return;
              }
              // Preserve the existing tri-state behavior: an unverified read
              // is never interpreted as "no repository".
              if (resolution.kind === 'unverified') {
                const known = this.lastRoomClassification.get(channelId);
                if (known) desired.set(channelId, { ...known, membershipSince });
                else if (this.running.has(channelId)) {
                  desired.set(channelId, { membershipSince, kind: 'named-repository' });
                }
                this.noteRoomRepositoryUnverified(channelId, resolution.reason);
                return;
              }
              const dm = await client.getDirectMessage(channelId);
              const entry: DesiredChannel = {
                membershipSince,
                kind:
                  dm && dm.participants.includes(this.agent.publicKey)
                    ? 'direct-message'
                    : 'named-repository',
              };
              this.lastRoomClassification.set(channelId, entry);
              desired.set(channelId, entry);
            })(),
          );
          if (this.quarantine.get(channelId)?.reason.startsWith('classification:')) {
            this.quarantine.noteSuccess(channelId);
          }
        } catch (error) {
          // A failed Room classification cannot abort the fleet or delete a
          // running Room. Carry its last confirmed shape while its single
          // quarantine record applies a short transport backoff.
          const reason = error instanceof Error ? error.message : String(error);
          this.quarantine.noteFailure(channelId, new Error(`classification: ${reason}`));
          const known = this.lastRoomClassification.get(channelId);
          if (knownRoom) {
            desired.set(channelId, {
              membershipSince,
              kind: 'repository',
              repositoryRoom: knownRoom,
            });
          } else if (known) {
            desired.set(channelId, { ...known, membershipSince });
          } else if (this.running.has(channelId)) {
            desired.set(channelId, { membershipSince, kind: 'named-repository' });
          }
        }
      });

      for (const channelId of desired.keys()) this.roomRemovalConfirmations.delete(channelId);
      for (const [channelId, running] of [...this.running]) {
        if (desired.has(channelId)) continue;
        const confirmations = (this.roomRemovalConfirmations.get(channelId) ?? 0) + 1;
        this.roomRemovalConfirmations.set(channelId, confirmations);
        if (confirmations < REMOVAL_CONFIRMATION_READS) {
          this.confirmationPending = true;
          console.warn(
            `[thin-core] Room ${channelId} is absent from the successful membership read ` +
              `(${confirmations}/${REMOVAL_CONFIRMATION_READS}); keeping it running until ` +
              'successful reads corroborate removal',
          );
          continue;
        }
        this.roomRemovalConfirmations.delete(channelId);
        // Stop intake first. Body drains accepted turns before dispose returns.
        running.controller.abort();
        await running.promise.catch(() => undefined);
      }

      await mapWithConcurrency([...desired], ROOM_JOIN_CONCURRENCY, async ([channelId, target]) => {
        try {
          await withRoomDeadline(
            channelId,
            'join',
            (async () => {
              if (this.running.has(channelId)) {
                await this.reconcileRoomJoinNotice(client, channelId, { kind: 'recovered' });
                return;
              }
              // One Room that cannot be joined is a fact about that Room, not about
              // discovery. Isolate it here: a throw used to abort the whole pass,
              // so a single unservable Room (a local-only repo bound on another
              // checkout is the observed case) both starved every Room behind it in
              // this loop of its join and pinned discovery to the 5s error backoff
              // forever.
              if (!this.quarantine.mayAttempt(channelId)) return;
              // An archived Room is never served again this process. The in-memory
              // answer is a cache of the relay's own terminal verdict (see the
              // quarantine handler and the proactive read below); while it stands,
              // the Room costs discovery literally nothing — not even the read.
              if (this.quarantine.get(channelId)?.kind === 'terminal-inert') return;
              try {
                // Ask the relay BEFORE serving: an archived Room refuses every write
                // a fresh Body would attempt, so the first serve cycle would only
                // end in the identical HTTP 400 quarantine. One cheap metadata read
                // on join turns that loop into a skip.
                const metadata = await client.getChannelMetadata(channelId).catch(() => null);
                if (metadata?.archived) {
                  this.noteArchivedRoom(
                    channelId,
                    'the relay projection reports this Room archived',
                  );
                  return;
                }
                if (target.kind === 'repository') {
                  let room = this.runtime.rooms.find(
                    (candidate) => candidate.channelId === channelId,
                  );
                  if (
                    room &&
                    target.roomRepository &&
                    !sameRepositoryBinding(room.repo.repository, target.roomRepository.binding)
                  ) {
                    const replacement = await this.materializeRoom(
                      channelId,
                      target.membershipSince,
                      target.roomRepository,
                    );
                    replacement.root = room.root;
                    replacement.mergeWorker = room.mergeWorker;
                    const roomIndex = this.runtime.rooms.indexOf(room);
                    this.runtime.rooms[roomIndex] = replacement;
                    room = replacement;
                    await writeRuntimeRecord(this.runtime);
                  }
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
                this.quarantine.noteSuccess(channelId);
                await this.reconcileRoomJoinNotice(client, channelId, { kind: 'recovered' });
              } catch (error) {
                const discovery = this.noteRoomDiscoveryFailure(channelId, error);
                if (discovery.announced) {
                  await this.reconcileRoomJoinNotice(client, channelId, {
                    kind: 'failed',
                    retryLabel: discovery.retryLabel,
                  }).catch((noticeError: unknown) =>
                    isArchivedChannelError(noticeError)
                      ? this.noteArchivedRoom(
                          channelId,
                          'join-status notice was refused: channel is archived',
                        )
                      : console.warn(
                          `[thin-core] Room ${channelId} join-status notice could not be sent:`,
                          noticeError,
                        ),
                  );
                }
              }
            })(),
          );
        } catch (error) {
          // The deadline itself sits outside the join body's catch. Keep it
          // Room-local too: one exhausted slot must not reject the full
          // reconcile pass after its siblings have already progressed.
          this.noteRoomDiscoveryFailure(channelId, error);
        }
      });
      await this.refreshPersonaIfSoulChanged(client);
      return 'member';
    } catch (error) {
      // A partially completed discovery pass cannot count toward consecutive
      // Room-removal proof. Keep every Room and start corroboration over.
      this.roomRemovalConfirmations.clear();
      throw error;
    } finally {
      client.disconnect();
    }
  }

  /**
   * Read the bounded, agent-authored Room tail plus tagged join notices. The
   * tail is only for the pre-tag legacy failure currently visible in peddle;
   * new episodes use the targeted tag filter. A recovery is resolved only
   * when it references the exact failure event (or is the legacy closure
   * published after that failure).
   */
  private async readRoomJoinNoticeState(
    client: BuzzClient,
    channelId: string,
  ): Promise<{ failure?: NostrEvent; recovered: boolean }> {
    // Production BuzzClient always owns this data door. A few narrow unit
    // stubs intentionally omit unrelated relay reads; absence there means no
    // durable notice rather than noisy retry logging.
    if (typeof client.query !== 'function') return { recovered: false };
    const events = await client.query([
      {
        kinds: [9],
        authors: [this.agent.publicKey],
        '#h': [channelId],
        '#t': [ROOM_JOIN_NOTICE_TAG],
        limit: ROOM_JOIN_NOTICE_QUERY_LIMIT,
      },
      {
        kinds: [9],
        authors: [this.agent.publicKey],
        '#h': [channelId],
        limit: ROOM_JOIN_NOTICE_QUERY_LIMIT,
      },
    ]);
    const byId = new Map(events.map((event) => [event.id, event]));
    const published = this.publishedRoomJoinFailures.get(channelId);
    if (published) byId.set(published.id, published);
    const ordered = [...byId.values()].sort(compareEvents);
    const failure = ordered
      .filter(
        (event) =>
          (hasEventTag(event, 't', ROOM_JOIN_NOTICE_TAG) &&
            hasEventTag(event, 'status', ROOM_JOIN_UNAVAILABLE_STATUS)) ||
          event.content.startsWith(ROOM_JOIN_FAILURE_PREFIX),
      )
      .at(-1);
    if (!failure) return { recovered: false };
    const recovered = ordered.some(
      (event) =>
        (hasEventTag(event, 't', ROOM_JOIN_NOTICE_TAG) &&
          hasEventTag(event, 'status', ROOM_JOIN_RECOVERED_STATUS) &&
          hasEventTag(event, 'failure', failure.id)) ||
        (event.content === ROOM_JOIN_RECOVERY_TEXT && compareEvents(event, failure) > 0),
    );
    return { failure, recovered };
  }

  /**
   * The single Room join-notice data door. Both failure and recovery first
   * reconcile the relay-visible status episode; process-local quarantine is
   * never evidence that a captain-visible notice exists.
   */
  private async reconcileRoomJoinNotice(
    client: BuzzClient,
    channelId: string,
    desired: { kind: 'failed'; retryLabel: string } | { kind: 'recovered' },
  ): Promise<void> {
    if (desired.kind === 'recovered' && this.settledRoomJoinNotices.has(channelId)) return;
    if (desired.kind === 'failed') this.settledRoomJoinNotices.delete(channelId);
    let state: { failure?: NostrEvent; recovered: boolean };
    try {
      state = await this.readRoomJoinNoticeState(client, channelId);
    } catch (error) {
      if (desired.kind === 'failed') {
        console.warn(
          `[thin-core] Room ${channelId} existing join notice could not be read; ` +
            'publishing the current failure:',
          error,
        );
        state = { recovered: false };
      } else {
        console.warn(
          `[thin-core] Room ${channelId} join-recovery notice could not be reconciled:`,
          error,
        );
        return;
      }
    }

    if (desired.kind === 'failed') {
      if (state.failure && !state.recovered) {
        this.publishedRoomJoinFailures.set(channelId, state.failure);
        return;
      }
      const event = await client.messageSubmit(
        channelId,
        `${ROOM_JOIN_FAILURE_PREFIX} I will retry automatically in ${desired.retryLabel}.`,
        {
          extraTags: [
            ['t', ROOM_JOIN_NOTICE_TAG],
            ['status', ROOM_JOIN_UNAVAILABLE_STATUS],
          ],
        },
      );
      this.publishedRoomJoinFailures.set(channelId, event);
      return;
    }

    if (!state.failure || state.recovered) {
      this.settledRoomJoinNotices.add(channelId);
      this.publishedRoomJoinFailures.delete(channelId);
      return;
    }
    try {
      await client.messageSubmit(channelId, ROOM_JOIN_RECOVERY_TEXT, {
        extraTags: [
          ['t', ROOM_JOIN_NOTICE_TAG],
          ['status', ROOM_JOIN_RECOVERED_STATUS],
          ['failure', state.failure.id],
        ],
      });
      this.settledRoomJoinNotices.add(channelId);
      this.publishedRoomJoinFailures.delete(channelId);
    } catch (noticeError) {
      if (isArchivedChannelError(noticeError)) {
        this.noteArchivedRoom(channelId, 'join-recovery notice was refused: channel is archived');
      } else {
        console.warn(
          `[thin-core] Room ${channelId} join-recovery notice could not be reconciled:`,
          noticeError,
        );
      }
    }
  }

  /**
   * Record the relay's terminal `channel is archived` verdict for one Room:
   * logged once, then the Room is held inert — dropped from serving for the
   * life of this daemon process and never re-attempted by discovery. See the
   * `archivedRooms` docblock for why it is held rather than forgotten.
   */
  private noteArchivedRoom(channelId: string, reason: string): void {
    this.quarantine.noteArchived(channelId, reason);
    // Terminal evidence applies to every path, including best-effort notices
    // after a Room has started. Quiesce it immediately; its durable state is
    // left in place for an authoritative re-read after a future restart.
    this.running.get(channelId)?.controller.abort();
  }

  /**
   * One Room's serving loop died. A terminal archived-channel refusal is a
   * fact about the Room and parks it forever; anything else stays an ordinary
   * quarantine (the Room is retried when discovery next reaches it).
   */
  private handleQuarantinedRoom(channelId: string, error: unknown): void {
    if (isArchivedChannelError(error)) {
      this.noteArchivedRoom(channelId, 'the relay refused writes to it: channel is archived');
    } else {
      this.quarantine.noteFailure(channelId, error);
    }
  }

  /**
   * Record one Room's join failure without letting it reach the discovery
   * pass. A DURABLE failure (`isDurableRoomJoinFailure`) is parked for
   * `DEFAULT_ROOM_DISCOVERY_RETRY_MS`; anything else is treated as transient
   * and retried on `DEFAULT_ROOM_DISCOVERY_TRANSIENT_RETRY_MS` — the relay,
   * the auth service, and git remotes all restart, and a Room parked through
   * such a window reads as an agent that went dark. The console line is
   * emitted only when the reason changes, either way.
   */
  private noteRoomDiscoveryFailure(
    channelId: string,
    error: unknown,
  ): {
    announced: boolean;
    retryLabel: string;
  } {
    const message = error instanceof Error ? error.message : String(error);
    const previous = this.quarantine.get(channelId);
    const next = this.quarantine.noteFailure(channelId, error);
    if (previous?.kind === next.kind && previous.reason === message)
      return { announced: false, retryLabel: '' };
    const retryMs = Math.max(0, (next.retryAt ?? this.now()) - this.now());
    const retryLabel =
      next.kind === 'durable-backoff'
        ? '10 minutes'
        : next.kind === 'owner-grant-backoff' && next.confirmations >= 3
          ? `${Math.max(10, Math.ceil(retryMs / 60_000))} minutes`
          : '30 seconds';
    return { announced: true, retryLabel };
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
      console.error(`[thin-core] per-room agent home unavailable at ${home}:`, error);
      return undefined;
    }
    return home;
  }

  private roomBodyConfig(workspaceRoot: string): BodyConfig {
    const agentHomeRoot = this.roomAgentHomeRoot(workspaceRoot);
    return {
      ...this.baseConfig,
      workspaceRoot,
      agentPrivateRoot: resolve(workspaceRoot, 'agent-private'),
      // Agent-authored memory is per-(agent, workspace): this daemon's own
      // runtime storage root is per-agent by construction (`runtime.ts`), and
      // `agent-memory.ts` adds the Workspace subdirectory. Never under any
      // Room root — memory outlives Rooms and is shared across them.
      agentMemoryRoot: resolve(dirname(this.configPath), 'memory'),
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
    boundRepo = await this.resolveServingRepo(room);
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
        resolveNamedRepository: (target) => this.resolveNamedRepository(channelId, target),
        refreshRepositoryTruth: (repo, checkpoint) => this.refreshBoundRepo(repo, checkpoint),
        syncPairingCheckout: (repo, tip) => this.syncPairingCheckout(repo, tip),
        runRepositoryGit: (repo, cwd, args) => this.runRepositoryGit(repo, cwd, args),
        repositoryAccessToken: (repo) => this.repositoryAccessToken(repo),
        resolveBindingOwnerKey: (repo) => this.resolveBindingOwnerKey(repo),
        onRoomPollSuccess: health.poll,
        onRoomPollFailure: health.failure,
        onRoomPresence: health.presence,
        runScheduleNow: (scheduleId) => {
          if (!this.runScheduleNow) throw new Error('schedule calendar is unavailable');
          return this.runScheduleNow(scheduleId);
        },
      },
    );
    const promise = body
      .runRepositoryRoomLoop(this.runtime.communityId, channelId, boundRepo, {
        signal: controller.signal,
      })
      .catch((error) => {
        if (!controller.signal.aborted) this.handleQuarantinedRoom(channelId, error);
      })
      .finally(async () => {
        await body.dispose();
        if (this.running.get(channelId)?.body === body) this.running.delete(channelId);
      });
    this.running.set(channelId, {
      body,
      boundRepo,
      editPolicy: 'repository',
      controller,
      promise,
      lastPollAt: startedAt,
      lastPresenceAt: startedAt,
      presence: 'offline',
      backoffUntil: 0,
      recovering: false,
    });
    console.log(`[thin-core] serving Room ${channelId} from ${boundRepo.localPath}`);
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
      resolveNamedRepository: (target) => this.resolveNamedRepository(channelId, target),
      onRoomPollSuccess: () => this.notePoll(channelId),
      onRoomPollFailure: (_roomId, retryInMs) => this.notePollFailure(channelId, retryInMs),
      onRoomPresence: (_roomId, status) => this.notePresence(channelId, status),
      runScheduleNow: (scheduleId) => {
        if (!this.runScheduleNow) throw new Error('schedule calendar is unavailable');
        return this.runScheduleNow(scheduleId);
      },
    });
    const promise = body
      .runConversationRoomLoop(channelId, kind, { signal: controller.signal })
      .catch((error) => {
        if (!controller.signal.aborted) this.handleQuarantinedRoom(channelId, error);
      })
      .finally(async () => {
        await body.dispose();
        if (this.running.get(channelId)?.body === body) this.running.delete(channelId);
      });
    this.running.set(channelId, {
      body,
      editPolicy: kind,
      controller,
      promise,
      lastPollAt: startedAt,
      lastPresenceAt: startedAt,
      presence: 'offline',
      backoffUntil: 0,
      recovering: false,
    });
    console.log(
      `[thin-core] serving ${kind === 'direct-message' ? 'read-only DM' : 'repo-less Room'} ${channelId}`,
    );
  }

  private resolveNamedRepository(
    roomId: string,
    target: NamedRepositoryTarget,
  ): Promise<BoundRepo> {
    const cacheKey = `${roomId}:${target.id}`;
    const existing = this.namedRepositoryResolutions.get(cacheKey);
    if (existing) return existing;
    const resolution = this.materializeNamedRepository(roomId, target).finally(() => {
      if (this.namedRepositoryResolutions.get(cacheKey) === resolution) {
        this.namedRepositoryResolutions.delete(cacheKey);
      }
    });
    this.namedRepositoryResolutions.set(cacheKey, resolution);
    return resolution;
  }

  private async materializeNamedRepository(
    roomId: string,
    target: NamedRepositoryTarget,
  ): Promise<BoundRepo> {
    const repositories = this.sharedRepositoriesRoot();
    const key = createHash('sha256')
      .update(`${target.kind}:${target.relayOwnerHex ?? target.owner}/${target.repo}`)
      .digest('hex');
    const root = resolve(repositories, `named-${key}`);
    await mkdir(repositories, { recursive: true, mode: 0o700 });
    if (!existsSync(root)) {
      const result = target.relayOwnerHex
        ? await gitAuthed(repositories, this.agent, target.relayOwnerHex, target.repo, [
            'clone',
            `${this.runtime.relayBaseUrl}/git/${target.relayOwnerHex}/${target.repo}`,
            root,
          ])
        : this.githubApp
          ? await this.githubApp.git(
              repositories,
              ['clone', `https://github.com/${target.owner}/${target.repo}.git`, root],
              {
                key,
                name: target.repo,
                remote: `git://github.com/${target.owner}/${target.repo}`,
                localOnly: false,
              },
              roomId,
            )
          : {
              ok: false,
              status: 1,
              stdout: '',
              stderr: 'GitHub App credentials are not configured',
            };
      if (!result.ok) {
        console.error(`[thin-core] named repository clone failed for ${target.id}:`, result.stderr);
        throw new Error(
          `repository ${target.id} could not be cloned or accessed with the available credentials`,
        );
      }
    }

    let local: LocalRepositoryBinding;
    try {
      local = await inspectLocalRepositoryBounded(root);
    } catch (error) {
      console.error(`[thin-core] named repository inspection failed for ${target.id}:`, error);
      throw new Error(`repository ${target.id} could not be verified after cloning`);
    }
    const matchesTarget = target.relayOwnerHex
      ? local.relayRepo?.ownerHex === target.relayOwnerHex && local.relayRepo.repo === target.repo
      : local.repository.remote === `git://github.com/${target.owner}/${target.repo}`;
    if (!matchesTarget) {
      throw new Error(`repository clone did not match the approved target ${target.id}`);
    }
    const truth = await this.repositoryTruth.resolve(local, 'corner-open', roomId);
    return { ...boundRepoFromTruth(truth), repositoryId: target.id };
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

  /**
   * The repository this daemon actually serves a Room from: beeline's dedicated
   * canonical checkout for a remote repo, or (only for a non-convergent
   * local-only repo, which has no origin to clone) the stored binding as-is.
   */
  private async resolveServingRepo(room: RoomRuntimeRecord): Promise<BoundRepo> {
    const truth = await this.repositoryTruth.resolve(room.repo, 'room-join', room.channelId);
    if (
      truth.binding.name !== room.repo.repository.name ||
      truth.binding.remote !== room.repo.repository.remote ||
      truth.binding.githubInstallationId !== room.repo.repository.githubInstallationId
    ) {
      room.repo.repository = truth.binding;
      await writeRuntimeRecord(this.runtime);
    }
    return boundRepoFromTruth(truth, room);
  }

  private async runRepositoryGit(repo: BoundRepo, cwd: string, args: string[]): Promise<GitResult> {
    if (repo.ownerHex) return gitAuthed(cwd, this.agent, repo.ownerHex, repo.repo, args);
    const binding = repo.truth?.binding;
    if (binding?.remote?.startsWith('git://github.com/')) {
      if (!this.githubApp) throw new Error('GitHub App credentials are not configured');
      return this.githubApp.git(cwd, args, binding, repo.truth?.roomId);
    }
    return git(cwd, args);
  }

  private async repositoryAccessToken(repo: BoundRepo): Promise<string | undefined> {
    const binding = repo.truth?.binding;
    if (!binding?.remote?.startsWith('git://github.com/')) return undefined;
    if (!this.githubApp) throw new Error('GitHub App credentials are not configured');
    return this.githubApp.repositoryInstallationToken(binding, repo.truth?.roomId);
  }

  /**
   * The Room binding author's CURRENT key after succession (auth-service
   * answer; undefined when unknown/non-GitHub). Lets Body accept a merge
   * approval signed by the successor of the identity that authored the
   * binding without teaching the daemon the succession ledger.
   */
  private async resolveBindingOwnerKey(repo: BoundRepo): Promise<string | undefined> {
    const binding = repo.truth?.binding;
    if (!binding?.remote?.startsWith('git://github.com/')) return undefined;
    return this.githubApp?.bindingOwnerKey(binding, repo.truth?.roomId);
  }

  private async refreshBoundRepo(
    repo: BoundRepo,
    checkpoint: RepositoryTruthCheckpoint,
  ): Promise<BoundRepo> {
    if (!repo.truth) return repo;
    const refreshed = boundRepoFromTruth(
      await this.repositoryTruth.refresh(repo.truth, checkpoint),
    );
    return {
      ...repo,
      ...refreshed,
      ...(repo.repositoryId ? { repositoryId: repo.repositoryId } : {}),
    };
  }

  private async syncPairingCheckout(repo: BoundRepo, landedTip: string): Promise<void> {
    if (!repo.truth) return;
    const result = await this.repositoryTruth.syncPairingCheckout(repo.truth, landedTip);
    if (result.status === 'fast-forwarded') {
      console.log(`[thin-core] pairing checkout fast-forwarded to ${landedTip.slice(0, 12)}`);
    } else if (result.status === 'refused') {
      console.warn(`[thin-core] pairing checkout sync refused: ${result.reason}`);
    }
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
    const placeholderRoot = this.repositoryTruth.checkoutPath(binding.key);
    const local = await this.repositoryTruth.resolve(
      {
        root: placeholderRoot,
        gitCommonDir: resolve(placeholderRoot, '.git'),
        targetBranch: roomRepository.targetBranch ?? 'main',
        repository: binding,
        ...(relayRepoFromBinding(binding) ? { relayRepo: relayRepoFromBinding(binding)! } : {}),
      },
      'room-join',
      channelId,
    );
    return {
      channelId,
      repo: {
        root: local.checkoutPath,
        gitCommonDir: local.gitCommonDir,
        ...(local.remoteName ? { remoteName: local.remoteName } : {}),
        targetBranch: local.targetBranch,
        repository: local.binding,
        ...(local.relayRepo ? { relayRepo: local.relayRepo } : {}),
      },
      // Stamp the storage root explicitly so this Room stays put even if the
      // runtime record later moves.
      root: this.roomRoot(channelId),
      membershipSince,
      discoveredAt: new Date().toISOString(),
    };
  }

  private async stopAll(): Promise<void> {
    const rooms = [...this.running.entries()];
    for (const [, room] of rooms) room.controller.abort();
    const drained = Promise.all(rooms.map(([, room]) => room.promise.catch(() => undefined)));
    const startedAt = this.now();
    const deadlineAt = Math.min(
      startedAt + this.drainDeadlineMs,
      this.drainDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    const remainingMs = Math.max(0, deadlineAt - startedAt);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolveDeadline) => {
      timer = setTimeout(() => resolveDeadline('deadline'), remainingMs);
    });
    const result = await Promise.race([drained.then(() => 'drained' as const), deadline]);
    if (timer) clearTimeout(timer);
    if (result === 'drained') return;
    console.error(
      `[thin-core] absolute drain deadline ${new Date(deadlineAt).toISOString()} reached; ` +
        'killing remaining turn children',
    );
    await Promise.allSettled(
      rooms.map(([channelId, room]) => room.body.forceRecoverRoom(channelId)),
    );
    await Promise.race([
      drained,
      new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 5_000);
      }),
    ]);
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
        `[thin-core] Room ${channelId} watchdog recovery: ` +
          `pollAge=${pollAge}ms presenceAge=${presenceAge}ms presence=${running.presence}`,
      );
      // forceSuspend kills a stuck ACP request; AbortController exits the Room
      // loop once its bounded relay request returns. reconcile starts a fresh
      // Body generation on its next control-plane pass.
      await running.body
        .forceRecoverRoom(channelId)
        .catch((error) =>
          console.error(`[thin-core] Room ${channelId} watchdog ACP cleanup failed:`, error),
        );
      running.controller.abort();
    }
  }
}
