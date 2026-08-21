import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { newIdentity } from '@beeline/gate';
import { runRelayCommand } from './relay-command.js';
import { findAgentRuntimeConfigPaths, inspectLocalRepository, readRuntimeRecord, updateRuntimeRelay } from './runtime.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-relay-command-'));
  cleanup.push(root);
  const result = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return root;
}

async function legacyRuntime(root: string): Promise<{ configPath: string; pubkey: string }> {
  const agent = newIdentity('legacy-agent');
  const body = newIdentity('legacy-body');
  const configPath = resolve(root, '.git', 'beeline', 'agents', agent.publicKey, 'runtime.json');
  await mkdir(resolve(configPath, '..'), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({
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
          channelId: '22222222-2222-4222-8222-222222222222',
          repo: inspectLocalRepository(root),
          membershipSince: 10,
          discoveredAt: new Date(0).toISOString(),
        },
      ],
      supervisorRoot: resolve(root, '.git'),
      relayBaseUrl: 'https://relay.buzzrouter.com',
      agentBinary: '/usr/bin/agent',
      mcpBinary: '/usr/bin/mcp',
      createdAt: new Date(0).toISOString(),
    })}\n`,
  );
  return { configPath, pubkey: agent.publicKey };
}

describe('beeline relay set legacy runtimes', () => {
  async function repoint(args: string[]): Promise<void> {
    const root = await repository();
    const stateHome = await mkdtemp(resolve(tmpdir(), 'beeline-relay-state-'));
    cleanup.push(stateHome);
    const legacy = await legacyRuntime(root);
    const lifecycle: string[] = [];
    const output: string[] = [];

    await runRelayCommand(args.map((arg) => (arg === '<pubkey>' ? legacy.pubkey : arg)), {
      cwd: () => root,
      findHostRuntimes: (cwd) => findAgentRuntimeConfigPaths({ XDG_STATE_HOME: stateHome }, cwd),
      stopRuntime: async (configPath) => {
        expect(configPath).toBe(legacy.configPath);
        lifecycle.push('stop');
        return 101;
      },
      updateRuntime: async (configPath, relayUrl) => {
        lifecycle.push('update');
        return updateRuntimeRelay(configPath, relayUrl);
      },
      launchRuntime: async (configPath) => {
        expect(configPath).toBe(legacy.configPath);
        lifecycle.push('start');
        return 202;
      },
      log: (line) => output.push(line),
    });

    expect(lifecycle).toEqual(['stop', 'update', 'start']);
    expect((await readRuntimeRecord(legacy.configPath)).relayBaseUrl).toBe('https://usebeeline.app');
    expect(output).toContain('[buzz] found 1 paired agent runtime(s); updating 1.');
    expect(output).toContain('[buzz] updated 1 paired agent runtime(s).');
  }

  it('discovers, repoints, and restarts a legacy runtime with --all', async () => {
    await repoint(['relay', 'set', 'https://usebeeline.app', '--all']);
  });

  it('discovers, repoints, and restarts a legacy runtime with --agent', async () => {
    await repoint(['relay', 'set', 'https://usebeeline.app', '--agent', '<pubkey>']);
  });
});
