import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

const git = promisify(execFile);

it('fetches a new target commit for each Room turn and reports the checked out SHA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-checkout-'));
  vi.stubEnv('PATH', '/usr/bin:/bin');
  try {
    const seed = join(root, 'seed');
    const remote = join(root, 'remote.git');
    await git('git', ['init', '-b', 'main', seed]);
    await writeFile(join(seed, 'code.txt'), 'first\n');
    await git('git', ['-C', seed, 'add', '.']);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    await git('git', ['-C', seed, 'commit', '-m', 'first'], { env });
    await git('git', ['clone', '--bare', seed, remote]);
    const identity = identityFromKey('11'.repeat(32), 'Bee');
    const coordinator = new RoomRuntimeCoordinator(
      {
        agent: {
          name: 'Bee',
          publicKey: identity.publicKey,
          secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
        },
        communityId: 'workspace',
        rooms: [],
        supervisorRoot: root,
        transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      } as AgentRuntimeRecord,
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute: vi.fn(async () => ({
            resolution: 'repository',
            key: 'fixture/repo',
            remote: `file://${remote}`,
            targetBranch: 'main',
          })),
        } as unknown as DaemonApiClient,
      },
    );
    const checkout = coordinator as unknown as {
      materializeRoomCheckout(roomId: string): Promise<string>;
      refreshRoomCheckout(roomId: string): Promise<{ cwd: string; branch: string; commit: string }>;
    };
    const cwd = await checkout.materializeRoomCheckout('room-1');
    const first = await checkout.refreshRoomCheckout('room-1');
    expect(await readFile(join(cwd, 'code.txt'), 'utf8')).toBe('first\n');
    expect(first.commit).toBe((await git('git', ['-C', seed, 'rev-parse', 'HEAD'])).stdout.trim());

    await writeFile(join(seed, 'code.txt'), 'second\n');
    await git('git', ['-C', seed, 'commit', '-am', 'second'], { env });
    const newHead = (await git('git', ['-C', seed, 'rev-parse', 'HEAD'])).stdout.trim();
    await git('git', ['--git-dir', remote, 'fetch', seed, 'main']);
    await git('git', ['--git-dir', remote, 'update-ref', 'refs/heads/main', newHead]);
    const second = await checkout.refreshRoomCheckout('room-1');
    expect(second).toEqual({
      cwd,
      branch: 'main',
      commit: newHead,
    });
    expect(second.commit).not.toBe(first.commit);
    expect(await readFile(join(cwd, 'code.txt'), 'utf8')).toBe('second\n');
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('serves an empty remote from Room state, then takes its first default-branch commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-empty-room-checkout-'));
  try {
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    await git('git', ['init', '--bare', '-b', 'main', remote]);
    const identity = identityFromKey('11'.repeat(32), 'Bee');
    const execute = vi.fn(async () => ({
      resolution: 'repository',
      key: 'fixture/empty',
      remote: `file://${remote}`,
      targetBranch: 'main',
    }));
    const coordinator = new RoomRuntimeCoordinator(
      {
        agent: {
          name: 'Bee',
          publicKey: identity.publicKey,
          secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
        },
        communityId: 'workspace',
        rooms: [],
        supervisorRoot: root,
        transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      } as AgentRuntimeRecord,
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      { daemonApi: { execute } as unknown as DaemonApiClient },
    );
    const checkout = coordinator as unknown as {
      refreshRoomCheckout(
        roomId: string,
      ): Promise<{ cwd: string; branch?: string; commit?: string }>;
    };
    const first = await checkout.refreshRoomCheckout('room-1');
    expect(first.branch).toBeUndefined();
    expect(first.commit).toBeUndefined();
    expect(execute).toHaveBeenCalledWith('noteEmptyRoomRepository', { roomId: 'room-1' });
    await git('git', ['clone', remote, seed]);
    await writeFile(join(seed, 'README.md'), '# empty\n');
    await git('git', ['-C', seed, 'add', 'README.md']);
    await git('git', [
      '-C',
      seed,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'first',
    ]);
    await git('git', ['-C', seed, 'push', 'origin', 'main']);
    const next = await checkout.refreshRoomCheckout('room-1');
    expect(next.branch).toBe('main');
    expect(next.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await readFile(join(next.cwd, 'README.md'), 'utf8')).toBe('# empty\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
