import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createBuzzClient,
  publishEvent,
  type Identity,
  type RepositoryBinding,
} from '@beeline/buzz-client';
import { getPublicKey, signEvent, type NostrEvent } from '@beeline/nostr';
import { newIdentity } from '@beeline/gate';
import { GitHubAppRuntime } from './github-app.js';
import {
  GITHUB_EVENT_HEALTH_TAG,
  GITHUB_EVENT_TAG,
  GitHubEventsApiSource,
  type GitHubRepositoryTarget,
  type RepositoryEvent,
  type RepositoryEventSource,
} from './github-events.js';
import { RepositoryEventsState } from './events-state.js';
import {
  defaultSupervisorRoot,
  readRuntimeRecord,
  runtimeIdentity,
  type AgentRuntimeRecord,
} from './runtime.js';
import type { DaemonNotifier } from './systemd.js';

export const EVENTS_SERVICE_IDENTITY_NAME = 'beeline-events';
export const EVENTS_ACTIVE_POLL_MS = 15_000;
export const EVENTS_IDLE_POLL_BASE_MS = 60_000;
export const EVENTS_IDLE_POLL_MAX_MS = 5 * 60_000;
export const EVENTS_ERROR_BACKOFF_BASE_MS = 5_000;
export const EVENTS_ERROR_BACKOFF_MAX_MS = 5 * 60_000;
export const EVENTS_DEGRADED_AFTER_FAILURES = 3;
export const EVENTS_LOOP_TICK_MAX_MS = 5_000;
export const EVENTS_DISCOVERY_INTERVAL_MS = 60_000;
export const EVENTS_REPOSITORY_CONCURRENCY = 3;
export const EVENTS_PUBLISH_DEADLINE_MS = 25_000;
/** Whole fleet pass ceiling; bounds shutdown and rotates work across repositories. */
export const EVENTS_TICK_DEADLINE_MS = 90_000;

interface StoredEventsIdentity {
  version: 1;
  name: string;
  secretKeyHex: string;
  publicKey: string;
}

export interface RepositoryIngestionTarget extends GitHubRepositoryTarget {
  key: string;
  workspaceId: string;
  fullName: string;
  relayBaseUrl: string;
  relayHost: string;
  binding: RepositoryBinding;
  rooms: string[];
  /** Existing Room control identities used only to enroll the service key. */
  roomProvisioners: Map<string, Identity>;
  targetBranches: Set<string>;
  membershipError?: string;
}

export interface EventsServiceConfig {
  supervisorRoot: string;
  identityFile: string;
  githubAppId: string;
  githubPrivateKey: string;
  githubApiBaseUrl?: string;
  githubRequestTimeoutMs?: number;
}

export interface RepositoryEventsHealth {
  key: string;
  fullName: string;
  lastSuccessfulPollAt?: string;
  failures: number;
  lastError?: string;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function loadEventsServiceConfig(env: NodeJS.ProcessEnv = process.env): EventsServiceConfig {
  const supervisorRoot = defaultSupervisorRoot(env);
  const root = env.BEELINE_EVENTS_STATE_DIR?.trim() || resolve(supervisorRoot, 'beeline', 'events');
  const githubAppId = env.BEELINE_GITHUB_APP_ID?.trim() ?? '';
  const githubPrivateKey = env.BEELINE_GITHUB_APP_PRIVATE_KEY?.trim() ?? '';
  if (!/^\d+$/.test(githubAppId) || !githubPrivateKey) {
    throw new Error(
      'beeline-events requires BEELINE_GITHUB_APP_ID and BEELINE_GITHUB_APP_PRIVATE_KEY',
    );
  }
  return {
    supervisorRoot,
    identityFile: resolve(root, 'identity.json'),
    githubAppId,
    githubPrivateKey,
    ...(env.BEELINE_GITHUB_API_BASE_URL?.trim()
      ? { githubApiBaseUrl: env.BEELINE_GITHUB_API_BASE_URL.trim() }
      : {}),
    ...(parsePositiveNumber(env.BEELINE_GITHUB_EVENTS_REQUEST_TIMEOUT_MS)
      ? {
          githubRequestTimeoutMs: parsePositiveNumber(env.BEELINE_GITHUB_EVENTS_REQUEST_TIMEOUT_MS),
        }
      : {}),
  };
}

function eventsIdentity(value: StoredEventsIdentity): Identity {
  const secretKey = Uint8Array.from(Buffer.from(value.secretKeyHex, 'hex'));
  if (secretKey.length !== 32 || getPublicKey(secretKey) !== value.publicKey) {
    throw new Error('stored beeline-events identity is invalid');
  }
  return { name: value.name, secretKey, publicKey: value.publicKey };
}

/** Load or mint the one non-agent publishing identity owned by this service. */
export async function loadEventsServiceIdentity(path: string): Promise<Identity> {
  try {
    return eventsIdentity(JSON.parse(await readFile(path, 'utf8')) as StoredEventsIdentity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const identity = newIdentity(EVENTS_SERVICE_IDENTITY_NAME);
  const stored: StoredEventsIdentity = {
    version: 1,
    name: EVENTS_SERVICE_IDENTITY_NAME,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    publicKey: identity.publicKey,
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = resolve(dirname(path), `events-identity-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return identity;
}

function githubRemote(remote: string | undefined): { owner: string; repo: string } | undefined {
  const match = remote?.match(/^git:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

function targetKey(runtime: AgentRuntimeRecord, owner: string, repo: string): string {
  return createHash('sha256')
    .update(
      [runtime.relayBaseUrl, runtime.communityId, `${owner}/${repo}`.toLowerCase()].join('\u0000'),
    )
    .digest('hex');
}

/**
 * Discover durable repository Rooms without borrowing any agent identity.
 * Duplicate agent runtime views collapse into one workspace+repository poll.
 */
export async function discoverRepositoryIngestionTargets(
  supervisorRoot: string,
): Promise<RepositoryIngestionTarget[]> {
  const agentsRoot = resolve(supervisorRoot, 'beeline', 'agents');
  const entries = await readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  const grouped = new Map<string, RepositoryIngestionTarget>();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/i.test(entry.name)) continue;
    const configPath = resolve(agentsRoot, entry.name, 'runtime.json');
    let runtime: AgentRuntimeRecord;
    try {
      runtime = await readRuntimeRecord(configPath);
    } catch (error) {
      console.error(`[events] skipping unreadable runtime ${configPath}:`, error);
      continue;
    }
    for (const room of runtime.rooms) {
      const binding = room.repo.repository;
      const repository = githubRemote(binding.remote);
      if (!repository) continue;
      const key = targetKey(runtime, repository.owner, repository.repo);
      const existing = grouped.get(key);
      if (existing) {
        if (!existing.rooms.includes(room.channelId)) existing.rooms.push(room.channelId);
        // Never replace a proven merge-gate admin from another runtime view
        // with a plain linked agent. Do replace the fallback when a later
        // record carries the Room's persisted admin identity.
        if (room.mergeWorker || !existing.roomProvisioners.has(room.channelId)) {
          existing.roomProvisioners.set(
            room.channelId,
            runtimeIdentity(room.mergeWorker ?? runtime.agent),
          );
        }
        existing.targetBranches.add(room.repo.targetBranch.replace(/^refs\/heads\//, ''));
        continue;
      }
      grouped.set(key, {
        key,
        workspaceId: runtime.communityId,
        fullName: `${repository.owner}/${repository.repo}`,
        owner: repository.owner,
        repo: repository.repo,
        roomId: room.channelId,
        binding,
        ...(binding.githubInstallationId ? { installationId: binding.githubInstallationId } : {}),
        relayBaseUrl: runtime.relayBaseUrl,
        relayHost: runtime.relayHost ?? new URL(runtime.relayBaseUrl).host,
        rooms: [room.channelId],
        // The dedicated merge worker is a proven Room admin. Legacy Rooms may
        // not persist one; retain the linked agent as a best-effort authority
        // candidate and surface a degraded state if the relay refuses it.
        roomProvisioners: new Map([
          [room.channelId, runtimeIdentity(room.mergeWorker ?? runtime.agent)],
        ]),
        targetBranches: new Set([room.repo.targetBranch.replace(/^refs\/heads\//, '')]),
      });
    }
  }
  return [...grouped.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/** Preserve the existing per-Room activity toggle without borrowing an agent key. */
export async function applyRepositoryEventToggles(
  targets: readonly RepositoryIngestionTarget[],
  identity: Identity,
  createClient: typeof createBuzzClient = createBuzzClient,
): Promise<RepositoryIngestionTarget[]> {
  const clients = new Map<string, ReturnType<typeof createBuzzClient>>();
  const clientFor = (target: RepositoryIngestionTarget) => {
    const key = `${target.relayBaseUrl}\u0000${target.relayHost}`;
    let client = clients.get(key);
    if (!client) {
      client = createClient({
        baseUrl: target.relayBaseUrl,
        host: target.relayHost,
        identity,
        batchQueries: true,
      });
      clients.set(key, client);
    }
    return client;
  };
  const provisioners = new Map<string, ReturnType<typeof createBuzzClient>>();
  const provisionerFor = (target: RepositoryIngestionTarget, roomId: string) => {
    const provisioner = target.roomProvisioners.get(roomId);
    if (!provisioner) throw new Error(`no Room provisioner is available for ${roomId}`);
    const key = `${target.relayBaseUrl}\u0000${target.relayHost}\u0000${provisioner.publicKey}`;
    let client = provisioners.get(key);
    if (!client) {
      client = createClient({
        baseUrl: target.relayBaseUrl,
        host: target.relayHost,
        identity: provisioner,
        batchQueries: true,
      });
      provisioners.set(key, client);
    }
    return client;
  };
  try {
    const resolved = await Promise.all(
      targets.map(async (target) => {
        const membershipErrors: string[] = [];
        const rooms = (
          await Promise.all(
            target.rooms.map(async (roomId) => {
              try {
                const serviceClient = clientFor(target);
                if (!(await serviceClient.isMember(roomId, identity.publicKey))) {
                  const provisioner = provisionerFor(target, roomId);
                  await provisioner.addMember(roomId, identity.publicKey, 'member');
                  await provisioner.waitUntilMember(roomId, identity.publicKey, {
                    timeoutMs: 30_000,
                  });
                }
                const repository = await serviceClient.getRoomRepository(roomId);
                return repository?.githubEventsEnabled === false ? undefined : roomId;
              } catch (error) {
                // Keep the Room in the target so the core exposes a degraded
                // repository instead of silently advancing its cursor without
                // a publisher that the relay will accept.
                const message = error instanceof Error ? error.message : String(error);
                membershipErrors.push(`${roomId}: ${message}`);
                console.error(`[events] Room ${roomId} service enrollment failed:`, error);
                return roomId;
              }
            }),
          )
        ).filter((roomId): roomId is string => roomId !== undefined);
        return rooms.length > 0
          ? {
              ...target,
              rooms,
              ...(membershipErrors.length
                ? { membershipError: membershipErrors.join('; ').slice(0, 500) }
                : {}),
            }
          : undefined;
      }),
    );
    return resolved.filter((target): target is RepositoryIngestionTarget => target !== undefined);
  } finally {
    for (const client of clients.values()) client.disconnect();
    for (const client of provisioners.values()) client.disconnect();
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveWait) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolveWait();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function nextIdlePollMs(idlePolls: number): number {
  return Math.min(EVENTS_IDLE_POLL_MAX_MS, EVENTS_IDLE_POLL_BASE_MS * 2 ** idlePolls);
}

function errorBackoffMs(failures: number, random: () => number): number {
  const base = Math.min(
    EVENTS_ERROR_BACKOFF_MAX_MS,
    EVENTS_ERROR_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
  );
  return Math.round(base * (0.75 + random() * 0.5));
}

async function withConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  const queue = [...values];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const value = queue.shift();
        if (value === undefined) return;
        await visit(value);
      }
    }),
  );
}

function activityCard(
  identity: Identity,
  target: RepositoryIngestionTarget,
  roomId: string,
  event: RepositoryEvent,
  now: number,
): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: Math.floor(now / 1_000),
      kind: 9,
      tags: [
        ['h', roomId],
        ['t', 'agent-message'],
        ['t', GITHUB_EVENT_TAG],
        ['repo', target.fullName],
        ['workspace', target.workspaceId],
        ['service', EVENTS_SERVICE_IDENTITY_NAME],
        ['github-event-type', event.type],
        ['github-event-action', event.action],
        ['github-event-actor', event.actor],
        ['github-event-title', event.title],
        ['github-event-url', event.url],
        ['github-event-id', event.id],
      ],
      // The typed fields above are the only card contract. Deliberately do
      // not leave generic prose behind for a legacy transcript renderer.
      content: '',
    },
    identity.secretKey,
  );
}

function degradedCard(
  identity: Identity,
  target: RepositoryIngestionTarget,
  roomId: string,
  now: number,
): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: Math.floor(now / 1_000),
      kind: 9,
      tags: [
        ['h', roomId],
        ['t', 'agent-message'],
        ['t', GITHUB_EVENT_TAG],
        ['t', GITHUB_EVENT_HEALTH_TAG],
        ['repo', target.fullName],
        ['workspace', target.workspaceId],
        ['service', EVENTS_SERVICE_IDENTITY_NAME],
        ['status', 'degraded'],
      ],
      content:
        `Repository activity is delayed: Beeline cannot currently read or deliver GitHub events for ` +
        `${target.fullName}. It will keep retrying automatically.`,
    },
    identity.secretKey,
  );
}

/** One bounded, independently-failing poll pass over due repositories. */
export class RepositoryEventsCore {
  constructor(
    private readonly state: RepositoryEventsState,
    private readonly source: RepositoryEventSource,
    private readonly identity: Identity,
    private readonly deps: {
      publish?: (target: RepositoryIngestionTarget, event: NostrEvent) => Promise<void>;
      now?: () => number;
      random?: () => number;
    } = {},
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private publish(target: RepositoryIngestionTarget, event: NostrEvent): Promise<void> {
    if (this.deps.publish) return this.deps.publish(target, event);
    return publishEvent(
      {
        baseUrl: target.relayBaseUrl,
        host: target.relayHost,
        identity: this.identity,
      },
      event,
    ).then(() => undefined);
  }

  private async publishBounded(
    target: RepositoryIngestionTarget,
    event: NostrEvent,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`relay publish deadline exceeded after ${EVENTS_PUBLISH_DEADLINE_MS}ms`),
          ),
        EVENTS_PUBLISH_DEADLINE_MS,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([this.publish(target, event), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async deliverPending(
    target: RepositoryIngestionTarget,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const state = await this.state.record(target.key);
    const pending = state.pending;
    if (!pending) return false;
    const results = await Promise.allSettled(
      pending.cards
        .filter((card) => !card.published)
        .map(async (card) => {
          if (signal?.aborted) throw signal.reason;
          await this.publishBounded(target, card.event);
          await this.state.markCardPublished(target.key, card.event.id);
        }),
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
    const delivered = await this.state.record(target.key);
    if (delivered.pending?.cards.some((card) => !card.published)) {
      throw new Error('repository activity delivery remains incomplete');
    }
    await this.state.complete(target.key, {
      cursor: pending.cursor,
      sourceEventIds: pending.sourceEventIds,
      now: this.now(),
      nextPollAt: this.now() + EVENTS_ACTIVE_POLL_MS,
      active: true,
    });
    return true;
  }

  private async deliverDegradedNotice(
    target: RepositoryIngestionTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    const before = await this.state.record(target.key);
    const notice = before.degradedNotice;
    if (!notice) return;
    await Promise.allSettled(
      notice.cards
        .filter((card) => !card.published)
        .map(async (card) => {
          if (signal?.aborted) throw signal.reason;
          await this.publishBounded(target, card.event);
          await this.state.markDegradedCardPublished(target.key, card.roomId);
        }),
    );
    const after = await this.state.record(target.key);
    if (after.degradedNotice?.cards.every((card) => card.published)) {
      await this.state.markDegradedNoticePublished(target.key);
    }
  }

  private async pollOne(target: RepositoryIngestionTarget, signal?: AbortSignal): Promise<void> {
    const before = await this.state.record(target.key);
    if (this.now() < before.nextPollAt) return;
    try {
      if (await this.deliverPending(target, signal)) return;
      if (target.membershipError) {
        throw new Error(`service identity enrollment failed: ${target.membershipError}`);
      }
      const state = await this.state.record(target.key);
      const result = await this.source.read(target, state.cursor, { coldLimit: 20, signal });
      const seen = new Set(state.seenEventIds);
      const normalized = result.events.filter((event) => !seen.has(event.id));
      if (normalized.length) {
        const now = this.now();
        await this.state.reserve(target.key, {
          cursor: result.head,
          sourceEventIds: result.sourceEventIds,
          cards: normalized.flatMap((event) =>
            target.rooms.map((roomId) => ({
              roomId,
              event: activityCard(this.identity, target, roomId, event, now),
              published: false,
            })),
          ),
        });
        await this.deliverPending(target, signal);
        return;
      }
      const active = result.sourceEventIds.length > 0;
      await this.state.complete(target.key, {
        cursor: result.head,
        sourceEventIds: result.sourceEventIds,
        now: this.now(),
        nextPollAt: this.now() + (active ? EVENTS_ACTIVE_POLL_MS : nextIdlePollMs(state.idlePolls)),
        active,
      });
    } catch (error) {
      const current = await this.state.record(target.key);
      const failures = current.consecutiveFailures + 1;
      await this.state.fail(
        target.key,
        error,
        this.now() + errorBackoffMs(failures, this.deps.random ?? Math.random),
      );
      const failed = await this.state.record(target.key);
      console.error(
        `[events] ${target.workspaceId}/${target.fullName} poll failed; ` +
          `attempt=${failed.consecutiveFailures} retryAt=${new Date(failed.nextPollAt).toISOString()}:`,
        error,
      );
      if (
        failed.consecutiveFailures >= EVENTS_DEGRADED_AFTER_FAILURES &&
        !failed.degradedNoticePublished
      ) {
        // Reserve the signed episode before publishing. An ambiguous relay
        // response retries the identical Nostr id, so it remains one logical
        // notice without sacrificing eventual visibility.
        if (!failed.degradedNotice) {
          const now = this.now();
          await this.state.reserveDegradedNotice(
            target.key,
            target.rooms.map((roomId) => ({
              roomId,
              event: degradedCard(this.identity, target, roomId, now),
              published: false,
            })),
          );
        }
        await this.deliverDegradedNotice(target, signal);
      }
    }
  }

  async tick(
    targets: readonly RepositoryIngestionTarget[],
    signal?: AbortSignal,
  ): Promise<RepositoryEventsHealth[]> {
    await withConcurrency(targets, EVENTS_REPOSITORY_CONCURRENCY, (target) =>
      this.pollOne(target, signal),
    );
    const snapshot = await this.state.snapshot();
    return targets.map((target) => {
      const state = snapshot[target.key];
      return {
        key: target.key,
        fullName: target.fullName,
        ...(state?.lastSuccessfulPollAt
          ? { lastSuccessfulPollAt: state.lastSuccessfulPollAt }
          : {}),
        failures: state?.consecutiveFailures ?? 0,
        ...(state?.lastError ? { lastError: state.lastError } : {}),
      };
    });
  }
}

export function repositoryEventsStatus(health: readonly RepositoryEventsHealth[]): string {
  const degraded = health.filter((repo) => repo.failures > 0).length;
  const repos = health
    .map(
      (repo) =>
        `${repo.fullName}@${repo.lastSuccessfulPollAt ?? 'never'}` +
        (repo.failures ? `!${repo.failures}` : ''),
    )
    .join(',');
  return `repos=${health.length}; degraded=${degraded}; last_success=[${repos}]`;
}

/** Hosted repository-events consumer with explicit lifecycle and persistence owners. */
export async function runRepositoryEventsService(
  config: EventsServiceConfig,
  options: {
    signal?: AbortSignal;
    notifier: DaemonNotifier;
    discover?: (root: string) => Promise<RepositoryIngestionTarget[]>;
    source?: RepositoryEventSource;
    identity?: Identity;
    state: RepositoryEventsState;
  },
): Promise<void> {
  const notifier = options.notifier;
  const identity = options.identity ?? (await loadEventsServiceIdentity(config.identityFile));
  const github = new GitHubAppRuntime({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    ...(config.githubApiBaseUrl ? { apiBaseUrl: config.githubApiBaseUrl } : {}),
    ...(config.githubRequestTimeoutMs ? { requestTimeoutMs: config.githubRequestTimeoutMs } : {}),
  });
  const source =
    options.source ??
    new GitHubEventsApiSource(
      (target) =>
        github.repositoryInstallationToken(
          {
            key: `github:${target.owner}/${target.repo}`,
            name: `${target.owner}/${target.repo}`,
            remote: `git://github.com/${target.owner}/${target.repo}`,
            localOnly: false,
            ...(target.installationId ? { githubInstallationId: target.installationId } : {}),
          },
          target.roomId,
        ),
      {
        ...(config.githubApiBaseUrl ? { apiBaseUrl: config.githubApiBaseUrl } : {}),
        ...(config.githubRequestTimeoutMs
          ? { requestTimeoutMs: config.githubRequestTimeoutMs }
          : {}),
      },
    );
  const core = new RepositoryEventsCore(options.state, source, identity);
  const discover = options.discover ?? discoverRepositoryIngestionTargets;
  // Durable runtime discovery is local-only, so READY never depends on relay
  // or GitHub health. The Room-toggle reads happen inside the supervised loop.
  let targets = await discover(config.supervisorRoot);
  let nextDiscoveryAt = 0;
  let targetOffset = 0;
  await notifier.ready(`ready; identity=${identity.publicKey}; repos=${targets.length}`);
  while (!options.signal?.aborted) {
    if (Date.now() >= nextDiscoveryAt) {
      targets = await discover(config.supervisorRoot);
      if (!options.discover) targets = await applyRepositoryEventToggles(targets, identity);
      nextDiscoveryAt = Date.now() + EVENTS_DISCOVERY_INTERVAL_MS;
    }
    // Rotate the queue so a fleet larger than the concurrency cap stays
    // fair even when several slow repositories consume the whole bounded
    // tick. Materializer shutdown remains bounded by a completed pass, never
    // an in-flight network promise.
    const orderedTargets =
      targets.length > 0
        ? [...targets.slice(targetOffset), ...targets.slice(0, targetOffset)]
        : targets;
    if (targets.length > 0) {
      targetOffset = (targetOffset + EVENTS_REPOSITORY_CONCURRENCY) % targets.length;
    }
    const deadlineSignal = AbortSignal.timeout(EVENTS_TICK_DEADLINE_MS);
    const tickSignal = options.signal
      ? AbortSignal.any([options.signal, deadlineSignal])
      : deadlineSignal;
    const health = await core.tick(orderedTargets, tickSignal);
    await notifier.progress(repositoryEventsStatus(health));
    await wait(EVENTS_LOOP_TICK_MAX_MS, options.signal);
  }
  await notifier.stopping('repository event intake stopped; no poll remains in flight');
}
