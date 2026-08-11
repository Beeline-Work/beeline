import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createBuzzClient, type RepositoryBinding } from '@beeline/buzz-client';
import { git, gitAuthed, type Identity } from '@beeline/gate';
import { Body, type BoundRepo } from './body.js';
import type { BodyConfig } from './config.js';
import {
  inspectLocalRepository,
  runtimeIdentity,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
  type LocalRepositoryBinding,
  type RoomRuntimeRecord,
} from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

interface RunningRoom {
  body: Body;
  controller: AbortController;
  promise: Promise<void>;
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

/** One durable Workspace control plane multiplexing isolated Room bodies. */
export class WorkspaceSupervisor {
  private runtime: AgentRuntimeRecord;
  private readonly configPath: string;
  private readonly baseConfig: BodyConfig;
  private readonly agent: Identity;
  private readonly running = new Map<string, RunningRoom>();
  private readonly scheduler: SessionScheduler;

  constructor(runtime: AgentRuntimeRecord, configPath: string, baseConfig: BodyConfig) {
    this.runtime = runtime;
    this.configPath = configPath;
    this.baseConfig = baseConfig;
    this.agent = runtimeIdentity(runtime.agent);
    this.scheduler = new SessionScheduler({
      maxLiveSessions: Number(process.env.BUZZY_BODY_MAX_SESSIONS ?? '4'),
      idleMs: Number(process.env.BUZZY_BODY_SESSION_IDLE_MS ?? String(5 * 60_000)),
    });
  }

  activeRoomIds(): string[] {
    return [...this.running.keys()].sort();
  }

  async run(
    opts: { pollMs?: number; signal?: AbortSignal } = {},
  ): Promise<'aborted' | 'agent-removed'> {
    const pollMs = opts.pollMs ?? 5_000;
    try {
      while (!opts.signal?.aborted) {
        let waitMs = pollMs;
        try {
          if (!(await this.reconcile())) return 'agent-removed';
        } catch (error) {
          // Membership discovery is a control-plane poll. A transient relay
          // error must not tear down every active Room (and therefore restart
          // their pinned ACP processes). Keep serving the last known set and
          // honor the relay's advertised backoff before reconciling again.
          waitMs = reconcileRetryMs(error, pollMs);
          console.error(`[supervisor] discovery failed; retrying in ${waitMs}ms:`, error);
        }
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
      await this.stopAll();
      await this.scheduler.dispose();
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
      const desired = new Map<string, number>();
      for (const membership of memberships) {
        const channelId = membership.channelId;
        // listMyChannels reads the relay's current member/admin projections.
        // Known Rooms need no further control-plane queries: disappearing
        // from this list is the authoritative removal signal.
        if (this.runtime.rooms.some((candidate) => candidate.channelId === channelId)) {
          desired.set(channelId, membership.event.created_at);
          continue;
        }
        if ((await client.getChannelCommunityId(channelId)) !== this.runtime.communityId) continue;
        if (await client.getParentChannelId(channelId)) continue;
        if (!(await client.getChannelRepositoryBinding(channelId))) continue;
        desired.set(channelId, membership.event.created_at);
      }

      for (const [channelId, running] of [...this.running]) {
        if (desired.has(channelId)) continue;
        // Stop intake first. Body drains accepted turns before dispose returns.
        running.controller.abort();
        await running.promise.catch(() => undefined);
      }

      for (const [channelId, membershipSince] of desired) {
        if (this.running.has(channelId)) continue;
        let room = this.runtime.rooms.find((candidate) => candidate.channelId === channelId);
        if (!room) {
          const binding = await client.getChannelRepositoryBinding(channelId);
          if (!binding) continue;
          room = await this.materializeRoom(channelId, membershipSince, binding);
          this.runtime.rooms.push(room);
          await writeRuntimeRecord(this.runtime);
        }
        this.startRoom(room);
      }
      return true;
    } finally {
      client.disconnect();
    }
  }

  private startRoom(room: RoomRuntimeRecord): void {
    const controller = new AbortController();
    const workspaceRoot = resolve(dirname(this.configPath), 'rooms', room.channelId);
    const config: BodyConfig = { ...this.baseConfig, workspaceRoot };
    const body = new Body(
      config,
      runtimeIdentity(this.runtime.body),
      this.agent,
      room.mergeWorker ? runtimeIdentity(room.mergeWorker) : undefined,
      {
        scheduler: this.scheduler,
        statePath: resolve(workspaceRoot, 'body-state.json'),
      },
    );
    const promise = body
      .runRepositoryRoomLoop(this.runtime.communityId, room.channelId, boundRepoFromRoom(room), {
        signal: controller.signal,
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error(`[supervisor] Room ${room.channelId} quarantined:`, error);
        }
      })
      .finally(async () => {
        await body.dispose();
        if (this.running.get(room.channelId)?.body === body) this.running.delete(room.channelId);
      });
    this.running.set(room.channelId, { body, controller, promise });
    console.log(`[supervisor] serving Room ${room.channelId} from ${room.repo.root}`);
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
        : git(repositories, ['clone', cloneUrl(binding), root]);
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
      membershipSince,
      discoveredAt: new Date().toISOString(),
    };
  }

  private async stopAll(): Promise<void> {
    const rooms = [...this.running.values()];
    for (const room of rooms) room.controller.abort();
    await Promise.all(rooms.map((room) => room.promise.catch(() => undefined)));
  }
}
