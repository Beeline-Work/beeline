import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { newIdentity } from '@beeline/gate';
import {
  canonicalizeOrigin,
  inspectLocalRepository,
  pairRepositoryAgent,
  readRuntimeRecord,
} from './runtime.js';

const cleanup: string[] = [];

function run(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

async function repository(origin?: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), 'beeline-runtime-'));
  cleanup.push(path);
  run(path, ['init', '-q', '-b', 'main']);
  if (origin) run(path, ['remote', 'add', 'origin', origin]);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('repository binding', () => {
  it('normalizes credentialed HTTPS and SSH clones to the same remote identity', () => {
    expect(canonicalizeOrigin('https://token@example.com/Acme/widget.git', '/tmp/repo')).toBe(
      'git://example.com/Acme/widget',
    );
    expect(canonicalizeOrigin('git@example.com:Acme/widget.git', '/tmp/repo')).toBe(
      'git://example.com/Acme/widget',
    );
  });

  it('converges clones of one origin and keeps local-only repositories separate', async () => {
    const first = await repository('git@example.com:Acme/widget.git');
    const second = await repository('https://example.com/Acme/widget.git');
    expect(inspectLocalRepository(first).repository.key).toBe(
      inspectLocalRepository(second).repository.key,
    );

    const local = await repository();
    const otherLocal = await repository();
    const localBinding = inspectLocalRepository(local).repository;
    expect(localBinding.localOnly).toBe(true);
    expect(localBinding.remote).toBeUndefined();
    expect(inspectLocalRepository(local).repository.key).toBe(localBinding.key);
    expect(localBinding.key).not.toBe(inspectLocalRepository(otherLocal).repository.key);
  });
});

describe('pair → run unification', () => {
  it('binds the current repo, stores machine identities, and launches the daemon', async () => {
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('agent');
    const body = newIdentity('body');
    const mergeWorker = newIdentity('merge-worker');
    let launchedPath = '';
    const result = await pairRepositoryAgent(
      {
        code: 'BUZZ-ABCD-EFGH',
        cwd: root,
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/usr/bin/agent',
        mcpBinary: '/usr/bin/mcp',
        agentIdentity: agent,
        bodyIdentity: body,
        mergeWorkerIdentity: mergeWorker,
      },
      {
        redeem: async (code) => {
          expect(code).toBe('BUZZ-ABCD-EFGH');
          return {
            communityId: '11111111-1111-4111-8111-111111111111',
            pairedBy: 'a'.repeat(64),
            joined: true,
            agent: {
              agentId: 'agent-id',
              communityId: '11111111-1111-4111-8111-111111111111',
              displayName: 'Agent',
              pubkey: agent.publicKey,
              createdAt: 1,
              raw: {} as never,
            },
          };
        },
        resolveRoom: async (_pairing, binding, mergeWorkerPubkey) => {
          expect(binding.name).toBe('project');
          expect(mergeWorkerPubkey).toBe(mergeWorker.publicKey);
          return {
            channelId: '22222222-2222-4222-8222-222222222222',
            created: true,
            joined: true,
            mergeWorkerProvisioned: true,
          };
        },
        launch: async (path) => {
          launchedPath = path;
          return 4242;
        },
      },
    );

    expect(result.pid).toBe(4242);
    expect(launchedPath).toBe(result.configPath);
    expect(result.runtime.repo.root).toBe(root);
    expect(result.runtime.repo.repository.localOnly).toBe(false);
    const stored = await readRuntimeRecord(result.configPath);
    expect(stored.agent.publicKey).toBe(agent.publicKey);
    expect(stored.body.publicKey).toBe(body.publicKey);
    expect(stored.mergeWorker?.publicKey).toBe(mergeWorker.publicKey);
    expect(stored.agentBinary).toBe('/usr/bin/agent');
    expect(await readFile(result.configPath, 'utf8')).not.toContain('token@');
  });
});
