import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newIdentity } from '@beeline/gate';
import type { NostrEvent } from '@beeline/nostr';
import {
  RepositoryEventsState,
  type EventsStateData,
  type RepositoryEventsStatePersistence,
} from './events-state.js';
import {
  RepositoryEventsCore,
  applyRepositoryEventToggles,
  discoverRepositoryIngestionTargets,
  repositoryEventsStatus,
  type RepositoryIngestionTarget,
} from './events-service.js';
import { GitHubEventsApiSource, type RepositoryEventSource } from './github-events.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function target(overrides: Partial<RepositoryIngestionTarget> = {}): RepositoryIngestionTarget {
  const provisioner = newIdentity('room-provisioner');
  return {
    key: 'repo-key',
    workspaceId: 'workspace-1',
    fullName: 'acme/widget',
    owner: 'acme',
    repo: 'widget',
    roomId: 'room-1',
    relayBaseUrl: 'https://relay.example',
    relayHost: 'relay.example',
    binding: {
      key: 'github:1',
      name: 'acme/widget',
      remote: 'git://github.com/acme/widget',
      localOnly: false,
      githubInstallationId: 42,
    },
    installationId: 42,
    rooms: ['room-1'],
    roomProvisioners: new Map([['room-1', provisioner]]),
    targetBranches: new Set(['main']),
    ...overrides,
  };
}

function normalized(id: string) {
  return {
    source: 'github-poll' as const,
    id,
    repository: 'acme/widget',
    type: 'push' as const,
    action: 'pushed',
    actor: 'lena',
    occurredAt: '2026-08-24T12:00:00Z',
    summary: `lena pushed 1 commit to acme/widget:main (${id})`,
    branch: 'main',
  };
}

function durableState(): {
  persistence: RepositoryEventsStatePersistence;
  value: () => EventsStateData | undefined;
} {
  let value: EventsStateData | undefined;
  return {
    persistence: {
      load: async () => structuredClone(value),
      save: async (next) => {
        value = structuredClone(next);
      },
    },
    value: () => structuredClone(value),
  };
}

describe('RepositoryEventsCore', () => {
  it('resumes its durable cursor without duplicate cards across restart', async () => {
    const durable = durableState();
    let now = 1_000;
    const cursors: Array<string | undefined> = [];
    const source: RepositoryEventSource = {
      read: vi.fn(async (_target, cursor) => {
        cursors.push(cursor);
        return cursor
          ? { head: cursor, sourceEventIds: [], events: [] }
          : { head: '2', sourceEventIds: ['2'], events: [normalized('2')] };
      }),
    };
    const published: NostrEvent[] = [];
    const publish = async (_target: RepositoryIngestionTarget, event: NostrEvent) => {
      published.push(event);
    };
    const identity = newIdentity('events-service');
    await new RepositoryEventsCore(
      new RepositoryEventsState(durable.persistence),
      source,
      identity,
      {
        publish,
        now: () => now,
      },
    ).tick([target()]);

    now = 20_000;
    await new RepositoryEventsCore(
      new RepositoryEventsState(durable.persistence),
      source,
      identity,
      {
        publish,
        now: () => now,
      },
    ).tick([target()]);

    expect(cursors).toEqual([undefined, '2']);
    expect(published).toHaveLength(1);
    expect(published[0]!.content).toContain('(2)');
  });

  it('isolates one failed repository while a sibling publishes end-to-end from mocked GitHub', async () => {
    const durable = durableState();
    const rawPush = {
      id: '7',
      type: 'PushEvent',
      actor: { login: 'lena', type: 'User' },
      repo: { name: 'acme/widget' },
      created_at: '2026-08-24T12:00:00Z',
      payload: { ref: 'refs/heads/main', commits: [{}] },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/bad/')) throw new Error('bad repo transport');
      return new Response(JSON.stringify([rawPush]), { status: 200 });
    });
    const source = new GitHubEventsApiSource(async () => 'installation-token', {
      apiBaseUrl: 'https://github.test',
      fetch: fetchMock as typeof fetch,
    });
    const published: NostrEvent[] = [];
    const good = target();
    const bad = target({
      key: 'bad-key',
      fullName: 'acme/bad',
      repo: 'bad',
      roomId: 'room-bad',
      rooms: ['room-bad'],
    });
    const identity = newIdentity('events-service');
    const core = new RepositoryEventsCore(
      new RepositoryEventsState(durable.persistence),
      source,
      identity,
      {
        publish: async (_target, event) => published.push(event),
        now: () => 1_000,
        random: () => 0.5,
      },
    );

    const health = await core.tick([bad, good]);

    expect(published).toHaveLength(1);
    expect(published[0]!.pubkey).toBe(identity.publicKey);
    expect(published[0]!.tags).toContainEqual(['t', 'github-event']);
    expect(published[0]!.tags).toContainEqual(['service', 'beeline-events']);
    expect(published[0]!.content).toContain('lena pushed 1 commit to acme/widget:main');
    expect(health.find((repo) => repo.fullName === 'acme/bad')?.failures).toBe(1);
    expect(health.find((repo) => repo.fullName === 'acme/widget')?.failures).toBe(0);
  });

  it('retries a reserved card with the identical relay id after an ambiguous publish', async () => {
    const durable = durableState();
    let now = 1_000;
    let sourceReads = 0;
    const source: RepositoryEventSource = {
      read: async () => {
        sourceReads += 1;
        return { head: '9', sourceEventIds: ['9'], events: [normalized('9')] };
      },
    };
    const attempts: string[] = [];
    let fail = true;
    const publish = async (_target: RepositoryIngestionTarget, event: NostrEvent) => {
      attempts.push(event.id);
      if (fail) throw new Error('ambiguous relay timeout');
    };
    const identity = newIdentity('events-service');
    await new RepositoryEventsCore(
      new RepositoryEventsState(durable.persistence),
      source,
      identity,
      {
        publish,
        now: () => now,
        random: () => 0.5,
      },
    ).tick([target()]);

    fail = false;
    now = 7_000;
    await new RepositoryEventsCore(
      new RepositoryEventsState(durable.persistence),
      source,
      identity,
      {
        publish,
        now: () => now,
        random: () => 0.5,
      },
    ).tick([target()]);

    expect(sourceReads).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
  });

  it('publishes one degraded Room state per failure episode', async () => {
    const durable = durableState();
    let now = 1_000;
    const source: RepositoryEventSource = {
      read: async () => {
        throw new Error('GitHub down');
      },
    };
    const published: NostrEvent[] = [];
    const core = new RepositoryEventsCore(
      new RepositoryEventsState(durable.persistence),
      source,
      newIdentity('events-service'),
      {
        publish: async (_target, event) => published.push(event),
        now: () => now,
        random: () => 0.5,
      },
    );
    for (const at of [1_000, 7_000, 18_000, 40_000]) {
      now = at;
      await core.tick([target()]);
    }
    expect(
      published.filter((event) => event.tags.some((tag) => tag[1] === 'github-event-health')),
    ).toHaveLength(1);
    expect(repositoryEventsStatus(await core.tick([target()]))).toContain('acme/widget@never!4');
  });

  it('propagates service shutdown into an in-flight repository read', async () => {
    const durable = durableState();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const source: RepositoryEventSource = {
      read: async (_target, _cursor, options) => {
        observedSignal = options?.signal;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        });
        throw new Error('unreachable');
      },
    };
    const core = new RepositoryEventsCore(
      new RepositoryEventsState(durable.persistence),
      source,
      newIdentity('events-service'),
      { now: () => 1_000, random: () => 0.5 },
    );

    const ticking = core.tick([target()], controller.signal);
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort(new Error('service stopping'));

    await expect(ticking).resolves.toMatchObject([{ failures: 1 }]);
  });
});

describe('discoverRepositoryIngestionTargets', () => {
  it('enrolls the dedicated service key before reading Room configuration', async () => {
    const service = newIdentity('events-service');
    const provisioner = newIdentity('room-provisioner');
    const memberPubkeys = new Set<string>();
    const additions: Array<[string, string, string]> = [];
    const createClient = vi.fn((options: { identity: { publicKey: string } }) => ({
      isMember: async (_roomId: string, pubkey: string) => memberPubkeys.has(pubkey),
      addMember: async (roomId: string, pubkey: string, role: string) => {
        expect(options.identity.publicKey).toBe(provisioner.publicKey);
        additions.push([roomId, pubkey, role]);
        memberPubkeys.add(pubkey);
        return { status: 200, accepted: true, body: {} };
      },
      waitUntilMember: async () => undefined,
      getRoomRepository: async () => ({ githubEventsEnabled: true }),
      disconnect: () => undefined,
    }));

    const resolved = await applyRepositoryEventToggles(
      [target({ roomProvisioners: new Map([['room-1', provisioner]]) })],
      service,
      createClient as unknown as typeof import('@beeline/buzz-client').createBuzzClient,
    );

    expect(resolved).toHaveLength(1);
    expect(additions).toEqual([['room-1', service.publicKey, 'member']]);
  });

  it('groups duplicate agent views into one workspace/repository poll', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-events-discovery-'));
    temporary.push(root);
    const agent = newIdentity('agent');
    const body = newIdentity('body');
    const mergeWorker = newIdentity('merge-worker');
    const runtime = (roomId: string) => ({
      version: 2,
      communityId: 'workspace-1',
      pairedBy: 'a'.repeat(64),
      agent: {
        name: 'agent',
        secretKeyHex: Buffer.from(agent.secretKey).toString('hex'),
        publicKey: agent.publicKey,
      },
      body: {
        name: 'body',
        secretKeyHex: Buffer.from(body.secretKey).toString('hex'),
        publicKey: body.publicKey,
      },
      rooms: [
        {
          channelId: roomId,
          root: resolve(root, 'rooms', roomId),
          repo: {
            root: resolve(root, 'repo'),
            gitCommonDir: resolve(root, 'repo', '.git'),
            targetBranch: 'main',
            repository: {
              key: 'github:1',
              name: 'acme/widget',
              remote: 'git://github.com/acme/widget',
              localOnly: false,
              githubInstallationId: 42,
            },
          },
          mergeWorker: {
            name: 'merge-worker',
            secretKeyHex: Buffer.from(mergeWorker.secretKey).toString('hex'),
            publicKey: mergeWorker.publicKey,
          },
          membershipSince: 1,
          discoveredAt: new Date(0).toISOString(),
        },
      ],
      supervisorRoot: root,
      relayBaseUrl: 'https://relay.example',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    });
    const agentsRoot = resolve(root, 'beeline', 'agents');
    for (const [identity, roomId] of [
      [newIdentity('one'), 'room-a'],
      [newIdentity('two'), 'room-b'],
    ] as const) {
      const value = runtime(roomId);
      value.agent = {
        name: 'agent',
        secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
        publicKey: identity.publicKey,
      };
      const configPath = resolve(agentsRoot, identity.publicKey, 'runtime.json');
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify(value));
    }

    const targets = await discoverRepositoryIngestionTargets(root);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.rooms.sort()).toEqual(['room-a', 'room-b']);
    expect(targets[0]?.roomProvisioners.size).toBe(2);
    expect(
      [...(targets[0]?.roomProvisioners.values() ?? [])].every(
        (identity) => identity.publicKey === mergeWorker.publicKey,
      ),
    ).toBe(true);
  });
});
