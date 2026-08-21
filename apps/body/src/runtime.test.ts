import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { newIdentity } from '@beeline/gate';
import {
  canonicalizeOrigin,
  findAgentRuntimeConfigPaths,
  findRuntimeConfigPaths,
  inspectLocalRepository,
  normalizeRelayBaseUrl,
  pairRepositoryAgent,
  tryInspectLocalRepository,
  readRuntimeRecord,
  removeAgentRuntime,
  resolveRuntimeConfigPath,
  runtimeAgentCommand,
  stopRuntimeDaemon,
  updateRuntimeRelay,
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

/**
 * Machine-local agent state root for one test. Pairing defaults to
 * `$XDG_STATE_HOME`/`~/.local/state`; tests must never write there.
 */
async function stateRoot(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), 'beeline-state-'));
  cleanup.push(path);
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

  it('gives an actionable --repo error instead of a bare git failure outside any repository', async () => {
    const nonRepo = await mkdtemp(resolve(tmpdir(), 'beeline-non-repo-'));
    cleanup.push(nonRepo);
    expect(() => inspectLocalRepository(nonRepo)).toThrow('pass --repo <path>');
  });

  it('answers "no repository here" instead of throwing, for the optional pair-time binding', async () => {
    const nonRepo = await mkdtemp(resolve(tmpdir(), 'beeline-non-repo-'));
    cleanup.push(nonRepo);
    expect(tryInspectLocalRepository(nonRepo)).toBeNull();
    const repo = await repository('https://example.com/team/project.git');
    expect(tryInspectLocalRepository(repo)?.repository.name).toBe('project');
  });
});

describe('pairing with no repository', () => {
  it('pairs the agent with no Room binding and never resolves a repository Room', async () => {
    // A repository belongs to a ROOM, so an agent paired with none is a
    // valid configuration: it serves chat-only Rooms and materializes a
    // Room's repository on demand once one is bound.
    const nonRepo = await mkdtemp(resolve(tmpdir(), 'beeline-non-repo-pair-'));
    cleanup.push(nonRepo);
    const agent = newIdentity('agent');
    const body = newIdentity('body');
    const mergeWorker = newIdentity('merge-worker');
    const supervisorRoot = await stateRoot();
    let resolvedRoomCalls = 0;
    const result = await pairRepositoryAgent(
      {
        code: 'BUZZ-ABCD-EFGH',
        cwd: nonRepo,
        repo: null,
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/usr/bin/agent',
        mcpBinary: '/usr/bin/mcp',
        agentIdentity: agent,
        bodyIdentity: body,
        mergeWorkerIdentity: mergeWorker,
        supervisorRoot,
      },
      {
        redeem: async () => ({
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
        }),
        resolveRoom: async () => {
          resolvedRoomCalls += 1;
          throw new Error('resolveRoom must not run without a repository binding');
        },
        validate: async () => {
          throw new Error('validate must not run without a repository binding');
        },
        launch: async () => 4242,
      },
    );

    expect(resolvedRoomCalls).toBe(0);
    expect(result.room).toBeUndefined();
    expect(result.pid).toBe(4242);
    expect(result.runtime.rooms).toEqual([]);
    // The record still round-trips: an empty rooms list is a valid runtime,
    // and the supervisor discovers Rooms from relay membership anyway.
    const stored = await readRuntimeRecord(result.configPath);
    expect(stored.rooms).toEqual([]);
    expect(stored.communityId).toBe('11111111-1111-4111-8111-111111111111');
    expect(stored.agent.publicKey).toBe(agent.publicKey);
  });
});

describe('stored relay migration', () => {
  it('preserves an old-host runtime until an explicit relay update', async () => {
    const nonRepo = await mkdtemp(resolve(tmpdir(), 'beeline-relay-migration-'));
    cleanup.push(nonRepo);
    const supervisorRoot = await stateRoot();
    const agent = newIdentity('agent');
    const result = await pairRepositoryAgent(
      {
        code: 'BUZZ-ABCD-EFGH',
        cwd: nonRepo,
        repo: null,
        relayBaseUrl: 'https://relay.buzzrouter.com',
        relayHost: 'relay.buzzrouter.com',
        agentBinary: '/usr/bin/agent',
        mcpBinary: '/usr/bin/mcp',
        agentIdentity: agent,
        bodyIdentity: newIdentity('body'),
        mergeWorkerIdentity: newIdentity('merge-worker'),
        supervisorRoot,
      },
      {
        redeem: async () => ({
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
        }),
        resolveRoom: async () => {
          throw new Error('not called');
        },
        launch: async () => 4242,
      },
    );

    const legacy = await readRuntimeRecord(result.configPath);
    expect(legacy.relayBaseUrl).toBe('https://relay.buzzrouter.com');
    expect(legacy.relayHost).toBe('relay.buzzrouter.com');

    const misplacedConfigPath = resolve(nonRepo, 'misplaced-runtime.json');
    await writeFile(misplacedConfigPath, await readFile(result.configPath, 'utf8'));
    await expect(updateRuntimeRelay(misplacedConfigPath, 'https://usebeeline.app')).rejects.toThrow(
      'outside its canonical path',
    );
    await expect(readRuntimeRecord(result.configPath)).resolves.toMatchObject({
      relayBaseUrl: 'https://relay.buzzrouter.com',
      relayHost: 'relay.buzzrouter.com',
    });

    const migrated = await updateRuntimeRelay(result.configPath, 'https://usebeeline.app/');
    expect(migrated.runtime.relayBaseUrl).toBe('https://usebeeline.app');
    expect(migrated.runtime.relayHost).toBe('usebeeline.app');
    await expect(readRuntimeRecord(result.configPath)).resolves.toMatchObject({
      relayBaseUrl: 'https://usebeeline.app',
      relayHost: 'usebeeline.app',
      communityId: legacy.communityId,
      agent: legacy.agent,
      rooms: legacy.rooms,
    });
  });

  it('accepts only a relay origin and leaves invalid inputs unwritten', () => {
    expect(normalizeRelayBaseUrl('https://usebeeline.app/')).toEqual({
      relayBaseUrl: 'https://usebeeline.app',
      relayHost: 'usebeeline.app',
    });
    expect(normalizeRelayBaseUrl('http://127.0.0.1:3010')).toEqual({
      relayBaseUrl: 'http://127.0.0.1:3010',
      relayHost: '127.0.0.1:3010',
    });
    expect(() => normalizeRelayBaseUrl('wss://usebeeline.app')).toThrow('HTTP or HTTPS');
    expect(() => normalizeRelayBaseUrl('https://usebeeline.app/query')).toThrow(
      'must be an origin',
    );
  });

  it('waits for the previous daemon to stop before a replacement can launch', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'beeline-daemon-stop-'));
    cleanup.push(directory);
    const configPath = resolve(directory, 'runtime.json');
    await writeFile(configPath, '{}\n');
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
        'daemon',
        '--config',
        configPath,
      ],
      { stdio: 'ignore' },
    );
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    await new Promise((resolveReady) => setTimeout(resolveReady, 50));
    await writeFile(resolve(directory, 'daemon.pid'), `${child.pid}\n`);

    await expect(stopRuntimeDaemon(configPath, { timeoutMs: 2_000, pollMs: 10 })).resolves.toBe(
      child.pid,
    );
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  it('never signals an unrelated process referenced by a stale daemon pid file', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'beeline-daemon-stale-pid-'));
    cleanup.push(directory);
    const configPath = resolve(directory, 'runtime.json');
    await writeFile(configPath, '{}\n');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    await writeFile(resolve(directory, 'daemon.pid'), `${child.pid}\n`);

    try {
      await expect(stopRuntimeDaemon(configPath)).rejects.toThrow('refusing to stop it');
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('pair → run unification', () => {
  it('binds a GitHub-style repo without provisioning a Beeline merge worker', async () => {
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('agent');
    const body = newIdentity('body');
    const mergeWorker = newIdentity('merge-worker');
    const supervisorRoot = await stateRoot();
    let launchedPath = '';
    const result = await pairRepositoryAgent(
      {
        code: 'BUZZ-ABCD-EFGH',
        cwd: root,
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/usr/bin/agent',
        agentKind: 'codex',
        agentCommand: '/usr/bin/codex-acp',
        agentArgs: ['--profile', 'operator'],
        mcpBinary: '/usr/bin/mcp',
        agentIdentity: agent,
        bodyIdentity: body,
        mergeWorkerIdentity: mergeWorker,
        supervisorRoot,
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
          expect(mergeWorkerPubkey).toBeUndefined();
          return {
            channelId: '22222222-2222-4222-8222-222222222222',
            created: true,
            joined: true,
            mergeWorkerProvisioned: false,
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
    expect(result.runtime.version).toBe(2);
    expect(result.runtime.rooms).toHaveLength(1);
    expect(result.runtime.rooms[0]!.repo.root).toBe(root);
    expect(result.runtime.rooms[0]!.repo.repository.localOnly).toBe(false);
    const stored = await readRuntimeRecord(result.configPath);
    expect(stored.agent.publicKey).toBe(agent.publicKey);
    expect(stored.body.publicKey).toBe(body.publicKey);
    expect(stored.rooms[0]!.mergeWorker).toBeUndefined();
    expect(stored.agentBinary).toBe('/usr/bin/codex-acp');
    expect(runtimeAgentCommand(stored)).toEqual({
      kind: 'codex',
      command: '/usr/bin/codex-acp',
      args: ['--profile', 'operator'],
    });
    expect(await readFile(result.configPath, 'utf8')).not.toContain('token@');

    const prePicker = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    delete prePicker.agentKind;
    delete prePicker.agentCommand;
    delete prePicker.agentArgs;
    prePicker.agentBinary = '/usr/bin/agent';
    await writeFile(result.configPath, `${JSON.stringify(prePicker)}\n`);
    expect(runtimeAgentCommand(await readRuntimeRecord(result.configPath))).toEqual({
      kind: 'custom',
      command: '/usr/bin/agent',
      args: [],
    });
  });

  it('removes only the exact paired-agent runtime directory', async () => {
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('agent');
    const body = newIdentity('body');
    const mergeWorker = newIdentity('merge-worker');
    const supervisorRoot = await stateRoot();
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
        supervisorRoot,
      },
      {
        redeem: async () => ({
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
        }),
        resolveRoom: async () => ({
          channelId: '22222222-2222-4222-8222-222222222222',
          created: true,
          joined: true,
          mergeWorkerProvisioned: true,
        }),
        launch: async () => 4242,
      },
    );

    await removeAgentRuntime(result.configPath, agent.publicKey);
    expect(existsSync(result.configPath)).toBe(false);
    expect(existsSync(root)).toBe(true);
    await expect(
      removeAgentRuntime(resolve(root, 'runtime.json'), agent.publicKey),
    ).rejects.toThrow('refusing to remove unexpected agent runtime path');
  });

  it('persists a pair-time model/effort default and round-trips it through readRuntimeRecord', async () => {
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('agent');
    const supervisorRoot = await stateRoot();
    const result = await pairRepositoryAgent(
      {
        code: 'BUZZ-ABCD-EFGH',
        cwd: root,
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/usr/bin/agent',
        agentKind: 'claude',
        agentCommand: '/usr/bin/claude-agent-acp',
        mcpBinary: '/usr/bin/mcp',
        agentIdentity: agent,
        bodyIdentity: newIdentity('body'),
        mergeWorkerIdentity: newIdentity('merge-worker'),
        supervisorRoot,
        modelSelection: { model: 'sonnet', effort: 'high' },
      },
      {
        redeem: async () => ({
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
        }),
        resolveRoom: async () => ({
          channelId: '22222222-2222-4222-8222-222222222222',
          created: true,
          joined: true,
          mergeWorkerProvisioned: false,
        }),
        launch: async () => 4242,
      },
    );

    expect(result.runtime.modelSelection).toEqual({ model: 'sonnet', effort: 'high' });
    const stored = await readRuntimeRecord(result.configPath);
    expect(stored.modelSelection).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('rejects a runtime record with a malformed modelSelection field', async () => {
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('agent');
    const supervisorRoot = await stateRoot();
    const result = await pairRepositoryAgent(
      {
        code: 'BUZZ-ABCD-EFGH',
        cwd: root,
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/usr/bin/agent',
        mcpBinary: '/usr/bin/mcp',
        agentIdentity: agent,
        bodyIdentity: newIdentity('body'),
        mergeWorkerIdentity: newIdentity('merge-worker'),
        supervisorRoot,
      },
      {
        redeem: async () => ({
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
        }),
        resolveRoom: async () => ({
          channelId: '22222222-2222-4222-8222-222222222222',
          created: true,
          joined: true,
          mergeWorkerProvisioned: false,
        }),
        launch: async () => 4242,
      },
    );

    const raw = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<string, unknown>;
    raw.modelSelection = 'sonnet';
    await writeFile(result.configPath, `${JSON.stringify(raw)}\n`);
    await expect(readRuntimeRecord(result.configPath)).rejects.toThrow(
      'invalid agent runtime config',
    );
  });
});

describe('multi-identity guard (S0) + access policy', () => {
  const communityId = '11111111-1111-4111-8111-111111111111';

  async function pairAgent(
    root: string,
    supervisorRoot: string,
    agent = newIdentity('agent'),
    extra: { accessPolicy?: 'everyone' | 'creator'; accessAutoResponse?: string } = {},
  ) {
    return pairRepositoryAgent(
      {
        code: 'BUZZ-ABCD-EFGH',
        cwd: root,
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/usr/bin/agent',
        mcpBinary: '/usr/bin/mcp',
        agentIdentity: agent,
        bodyIdentity: newIdentity('body'),
        mergeWorkerIdentity: newIdentity('merge-worker'),
        supervisorRoot,
        ...(extra.accessPolicy ? { accessPolicy: extra.accessPolicy } : {}),
        ...(extra.accessAutoResponse ? { accessAutoResponse: extra.accessAutoResponse } : {}),
      },
      {
        redeem: async () => ({
          communityId,
          pairedBy: 'f'.repeat(64),
          joined: true,
          agent: {
            agentId: `agent-${agent.publicKey.slice(0, 8)}`,
            communityId,
            displayName: 'Agent',
            pubkey: agent.publicKey,
            createdAt: 1,
            raw: {} as never,
          },
        }),
        resolveRoom: async () => ({
          channelId: '22222222-2222-4222-8222-222222222222',
          created: true,
          joined: true,
          mergeWorkerProvisioned: false,
        }),
        launch: async () => 4242,
      },
    );
  }

  it('lets three fresh-key agents coexist in one Workspace on one host', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const a = await pairAgent(root, supervisorRoot, newIdentity('claude'));
    const b = await pairAgent(root, supervisorRoot, newIdentity('codex'));
    const c = await pairAgent(root, supervisorRoot, newIdentity('pi'));
    const pubkeys = new Set([
      a.runtime.agent.publicKey,
      b.runtime.agent.publicKey,
      c.runtime.agent.publicKey,
    ]);
    expect(pubkeys.size).toBe(3);
    // Each fresh identity owns its own runtime directory; nothing collides.
    const configs = await findAgentRuntimeConfigPaths({ XDG_STATE_HOME: supervisorRoot });
    expect(configs.length).toBe(3);
    expect(a.runtime.communityId).toBe(b.runtime.communityId);
    expect(b.runtime.communityId).toBe(c.runtime.communityId);
  });

  it('refuses to pair a second agent that reuses an existing identity (fail closed)', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const shared = newIdentity('pinned-key');
    await pairAgent(root, supervisorRoot, shared);
    // Reusing the same keypair — the pinned-BUZZ_AGENT_KEY hazard — is refused
    // before the one-shot code is consumed, never silently sharing one identity.
    await expect(pairAgent(root, supervisorRoot, shared)).rejects.toThrow(/already paired/);
  });

  it('persists the inviter-set access policy and custom auto-response', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const result = await pairAgent(root, supervisorRoot, newIdentity('agent'), {
      accessPolicy: 'creator',
      accessAutoResponse: 'go away, wildling',
    });
    const stored = await readRuntimeRecord(result.configPath);
    expect(stored.accessPolicy).toBe('creator');
    expect(stored.accessAutoResponse).toBe('go away, wildling');
    expect(stored.pairedBy).toBe('f'.repeat(64));
  });

  it('defaults to no persisted access policy (everyone) when unset', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const result = await pairAgent(root, supervisorRoot);
    const stored = await readRuntimeRecord(result.configPath);
    expect(stored.accessPolicy).toBeUndefined();
    expect(stored.accessAutoResponse).toBeUndefined();
  });

  it('round-trips the OS sandbox off-switch and rejects a bogus value', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const result = await pairAgent(root, supervisorRoot);
    // Absent means the default: wrap when a working bwrap is detected.
    expect((await readRuntimeRecord(result.configPath)).sandbox).toBeUndefined();

    const raw = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<string, unknown>;
    raw.sandbox = 'off';
    await writeFile(result.configPath, `${JSON.stringify(raw)}\n`);
    expect((await readRuntimeRecord(result.configPath)).sandbox).toBe('off');

    // A typo must be a loud config error, never a silently-unsandboxed daemon.
    raw.sandbox = 'on';
    await writeFile(result.configPath, `${JSON.stringify(raw)}\n`);
    await expect(readRuntimeRecord(result.configPath)).rejects.toThrow(
      'invalid agent runtime config',
    );
  });
});

describe('runtime root migration', () => {
  async function pair(
    root: string,
    supervisorRoot: string,
    agent = newIdentity('agent'),
  ): Promise<{ configPath: string; agentPubkey: string; channelId: string }> {
    const channelId = '22222222-2222-4222-8222-222222222222';
    const result = await pairRepositoryAgent(
      {
        code: 'BUZZ-ABCD-EFGH',
        cwd: root,
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/usr/bin/agent',
        mcpBinary: '/usr/bin/mcp',
        agentIdentity: agent,
        bodyIdentity: newIdentity('body'),
        mergeWorkerIdentity: newIdentity('merge-worker'),
        supervisorRoot,
      },
      {
        redeem: async () => ({
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
        }),
        resolveRoom: async () => ({
          channelId,
          created: true,
          joined: true,
          mergeWorkerProvisioned: false,
        }),
        launch: async () => 4242,
      },
    );
    return { configPath: result.configPath, agentPubkey: agent.publicKey, channelId };
  }

  it('stores the runtime in the machine-local agent state home, not the paired repo .git', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const { configPath, agentPubkey, channelId } = await pair(root, supervisorRoot);

    expect(configPath).toBe(
      resolve(supervisorRoot, 'beeline', 'agents', agentPubkey, 'runtime.json'),
    );
    expect(configPath.startsWith(root)).toBe(false);
    // The Room's own storage root is explicit, so a later record move cannot
    // silently relocate an open corner's registered worktree.
    const stored = await readRuntimeRecord(configPath);
    expect(stored.rooms[0]!.root).toBe(
      resolve(supervisorRoot, 'beeline', 'agents', agentPubkey, 'rooms', channelId),
    );
    // The repository binding for the Room is unchanged: the paired Room still
    // works in the human's own checkout (captain's decision D1).
    expect(stored.rooms[0]!.repo.root).toBe(root);
  });

  it('leaves a compatibility pointer so beeline start still works from the paired repo', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const { configPath, agentPubkey } = await pair(root, supervisorRoot);

    const pointerPath = resolve(root, '.git', 'beeline', 'agents', agentPubkey, 'runtime.json');
    expect(existsSync(pointerPath)).toBe(true);
    expect(JSON.parse(await readFile(pointerPath, 'utf8'))).toEqual({
      version: 3,
      link: configPath,
    });

    expect(await findRuntimeConfigPaths(root)).toEqual([configPath]);
    expect(await resolveRuntimeConfigPath(pointerPath)).toBe(configPath);
    // Reading through the pointer yields the real record, not a parse error.
    expect((await readRuntimeRecord(pointerPath)).agent.publicKey).toBe(agentPubkey);
  });

  it('finds a runtime by agent pubkey without standing in any repository', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const { configPath } = await pair(root, supervisorRoot);

    expect(await findAgentRuntimeConfigPaths({ XDG_STATE_HOME: supervisorRoot })).toEqual([
      configPath,
    ]);
  });

  it('still resolves and runs a runtime recorded in the old repo-anchored layout', async () => {
    // Exactly the shape an already-paired daemon has on disk today: the record
    // lives in the repo's .git, supervisorRoot is that git dir, and no Room
    // carries an explicit root.
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('legacy-agent');
    const body = newIdentity('legacy-body');
    const channelId = '22222222-2222-4222-8222-222222222222';
    const gitCommonDir = resolve(root, '.git');
    const legacyDir = resolve(gitCommonDir, 'beeline', 'agents', agent.publicKey);
    const legacyPath = resolve(legacyDir, 'runtime.json');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 2,
        communityId: '11111111-1111-4111-8111-111111111111',
        pairedBy: 'a'.repeat(64),
        agent: {
          name: 'buzzy-agent',
          secretKeyHex: Buffer.from(agent.secretKey).toString('hex'),
          publicKey: agent.publicKey,
        },
        body: {
          name: 'buzzy-body',
          secretKeyHex: Buffer.from(body.secretKey).toString('hex'),
          publicKey: body.publicKey,
        },
        rooms: [
          {
            channelId,
            repo: inspectLocalRepository(root),
            membershipSince: 10,
            discoveredAt: new Date(0).toISOString(),
          },
        ],
        supervisorRoot: gitCommonDir,
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/usr/bin/agent',
        mcpBinary: '/usr/bin/mcp',
        createdAt: new Date(0).toISOString(),
      }),
    );

    const stored = await readRuntimeRecord(legacyPath);
    expect(stored.agent.publicKey).toBe(agent.publicKey);
    expect(stored.supervisorRoot).toBe(gitCommonDir);
    // No root is stamped onto an existing Room: the supervisor derives its
    // current, unchanged location from the config path instead of moving it.
    expect(stored.rooms[0]!.root).toBeUndefined();
    // beeline start from the repo keeps finding it with no pointer present.
    expect(await findRuntimeConfigPaths(root)).toEqual([legacyPath]);
    // Host-scoped commands also include a legacy runtime found from the
    // current checkout, even when there is no machine-local state record.
    expect(await findAgentRuntimeConfigPaths({ XDG_STATE_HOME: await stateRoot() }, root)).toEqual([
      legacyPath,
    ]);
  });

  it('finds legacy runtimes in repositories registered by state-home Room bindings', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const stateRuntime = await pair(root, supervisorRoot, newIdentity('state-agent'));
    const agent = newIdentity('legacy-agent');
    const body = newIdentity('legacy-body');
    const legacyPath = resolve(root, '.git', 'beeline', 'agents', agent.publicKey, 'runtime.json');
    await mkdir(resolve(legacyPath, '..'), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 2,
        communityId: '11111111-1111-4111-8111-111111111111',
        pairedBy: 'a'.repeat(64),
        agent: {
          name: agent.name,
          secretKeyHex: Buffer.from(agent.secretKey).toString('hex'),
          publicKey: agent.publicKey,
        },
        body: {
          name: body.name,
          secretKeyHex: Buffer.from(body.secretKey).toString('hex'),
          publicKey: body.publicKey,
        },
        rooms: [
          {
            channelId: '33333333-3333-4333-8333-333333333333',
            repo: inspectLocalRepository(root),
            membershipSince: 10,
            discoveredAt: new Date(0).toISOString(),
          },
        ],
        supervisorRoot: resolve(root, '.git'),
        relayBaseUrl: 'http://relay.test',
        agentBinary: '/usr/bin/agent',
        mcpBinary: '/usr/bin/mcp',
        createdAt: new Date(0).toISOString(),
      }),
    );

    const configs = await findAgentRuntimeConfigPaths({ XDG_STATE_HOME: supervisorRoot }, supervisorRoot);
    expect(new Set(configs)).toEqual(new Set([stateRuntime.configPath, legacyPath]));
  });

  it('removes the repo-anchored pointer along with the runtime it points at', async () => {
    const root = await repository('https://example.com/team/project.git');
    const supervisorRoot = await stateRoot();
    const { configPath, agentPubkey } = await pair(root, supervisorRoot);
    const pointerPath = resolve(root, '.git', 'beeline', 'agents', agentPubkey, 'runtime.json');

    await removeAgentRuntime(configPath, agentPubkey, [resolve(root, '.git')]);

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(pointerPath)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });
});

describe('a pair run that fails after redemption', () => {
  const communityId = '22222222-2222-4222-8222-222222222222';

  /**
   * Redemption self-adds the agent as a Workspace member and publishes its
   * identity record — both irreversible relay writes. Model that membership
   * as a live Set so the assertion is the thing the app actually reads:
   * whether the agent is still a Workspace member afterwards.
   */
  function workspace(agentPubkey: string) {
    const members = new Set<string>();
    return {
      members,
      redeem: async () => {
        members.add(agentPubkey);
        return {
          communityId,
          pairedBy: 'a'.repeat(64),
          joined: true,
          agent: {
            agentId: 'agent-id',
            communityId,
            displayName: 'Agent',
            pubkey: agentPubkey,
            createdAt: 1,
            raw: {} as never,
          },
        };
      },
      abandonPairing: async () => {
        members.delete(agentPubkey);
      },
    };
  }

  it('leaves no half-created agent in the Workspace when the Room never resolves', async () => {
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('agent');
    const supervisorRoot = await stateRoot();
    const relay = workspace(agent.publicKey);

    await expect(
      pairRepositoryAgent(
        {
          code: 'BUZZ-ABCD-EFGH',
          cwd: root,
          relayBaseUrl: 'http://relay.test',
          agentBinary: '/usr/bin/agent',
          mcpBinary: '/usr/bin/mcp',
          agentIdentity: agent,
          bodyIdentity: newIdentity('body'),
          mergeWorkerIdentity: newIdentity('merge-worker'),
          supervisorRoot,
        },
        {
          redeem: relay.redeem,
          resolveRoom: async () => {
            throw new Error('relay unreachable');
          },
          abandonPairing: relay.abandonPairing,
          launch: async () => 1,
        },
      ),
    ).rejects.toThrow('relay unreachable');

    expect([...relay.members]).toEqual([]);
    // Nothing half-written on disk either.
    expect(
      existsSync(
        resolve(supervisorRoot, 'beeline', 'agents', agent.publicKey, 'runtime.json'),
      ),
    ).toBe(false);
  });

  it('rolls the registration back when the startup-protection check refuses', async () => {
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('agent');
    const relay = workspace(agent.publicKey);

    await expect(
      pairRepositoryAgent(
        {
          code: 'BUZZ-ABCD-EFGH',
          cwd: root,
          relayBaseUrl: 'http://relay.test',
          agentBinary: '/usr/bin/agent',
          mcpBinary: '/usr/bin/mcp',
          agentIdentity: agent,
          bodyIdentity: newIdentity('body'),
          mergeWorkerIdentity: newIdentity('merge-worker'),
          supervisorRoot: await stateRoot(),
        },
        {
          redeem: relay.redeem,
          resolveRoom: async () => ({ channelId: 'room-1', created: true }),
          validate: async () => {
            throw new Error('agent is in push-allowed');
          },
          abandonPairing: relay.abandonPairing,
          launch: async () => 1,
        },
      ),
    ).rejects.toThrow('agent is in push-allowed');

    expect([...relay.members]).toEqual([]);
  });

  it('keeps a completed pairing when only the daemon fails to launch', async () => {
    // The runtime record is already on disk here, so the pairing is real and
    // recoverable; undoing the registration would delete a valid agent.
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('agent');
    const relay = workspace(agent.publicKey);

    await expect(
      pairRepositoryAgent(
        {
          code: 'BUZZ-ABCD-EFGH',
          cwd: root,
          relayBaseUrl: 'http://relay.test',
          agentBinary: '/usr/bin/agent',
          mcpBinary: '/usr/bin/mcp',
          agentIdentity: agent,
          bodyIdentity: newIdentity('body'),
          mergeWorkerIdentity: newIdentity('merge-worker'),
          supervisorRoot: await stateRoot(),
        },
        {
          redeem: relay.redeem,
          resolveRoom: async () => ({ channelId: 'room-1', created: true }),
          abandonPairing: relay.abandonPairing,
          launch: async () => {
            throw new Error('spawn ENOENT');
          },
        },
      ),
    ).rejects.toThrow('beeline start --agent');

    expect([...relay.members]).toEqual([agent.publicKey]);
  });

  it('refuses before spending the one-shot code when runtime state is unwritable', async () => {
    const root = await repository('https://example.com/team/project.git');
    const agent = newIdentity('agent');
    const relay = workspace(agent.publicKey);
    // A file where the agents directory must go: the runtime write would have
    // thrown after redemption, which is exactly the ghost-making shape.
    const supervisorRoot = await stateRoot();
    await writeFile(resolve(supervisorRoot, 'beeline'), 'not a directory');

    await expect(
      pairRepositoryAgent(
        {
          code: 'BUZZ-ABCD-EFGH',
          cwd: root,
          relayBaseUrl: 'http://relay.test',
          agentBinary: '/usr/bin/agent',
          mcpBinary: '/usr/bin/mcp',
          agentIdentity: agent,
          bodyIdentity: newIdentity('body'),
          mergeWorkerIdentity: newIdentity('merge-worker'),
          supervisorRoot,
        },
        {
          redeem: relay.redeem,
          resolveRoom: async () => ({ channelId: 'room-1', created: true }),
          launch: async () => 1,
        },
      ),
    ).rejects.toThrow('cannot write agent runtime state');

    expect([...relay.members]).toEqual([]);
  });
});
