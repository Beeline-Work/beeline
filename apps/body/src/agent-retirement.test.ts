import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relocateAgentRuntime, retireRemovedAgent } from './agent-retirement.js';
import { DaemonApiError, isAgentRemovedError } from './daemon-api-client.js';
import { ThinDaemonCore } from './thin-core.js';
import { identityFromKey, stageMonolithAgentRuntime, runtimeDirectory } from './runtime.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function stage(seed: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-retirement-'));
  roots.push(root);
  const staged = await stageMonolithAgentRuntime({
    workspaceId: 'workspace',
    pairedBy: 'human',
    daemonExchangeToken: `bde_${seed.repeat(43).slice(0, 43)}`,
    agentBinary: '/nonexistent',
    agentKind: 'codex',
    agentCommand: '/nonexistent',
    agentArgs: [],
    mcpBinary: 'unused',
    agentIdentity: identityFromKey(seed.repeat(64).slice(0, 64), 'Bee'),
    bodyIdentity: identityFromKey(seed.repeat(64).slice(0, 63) + '1', 'Body'),
    supervisorRoot: root,
  });
  const config: BodyConfig = {
    agentBinary: '/nonexistent',
    agentKind: 'codex',
    agentCommand: '/nonexistent',
    agentArgs: [],
    mcpBinary: 'unused',
    readonlyMcpCommand: '/nonexistent',
    agentEnv: {},
    workspaceRoot: root,
    autoApprovePermissions: false,
  };
  return { root, staged, config };
}

/**
 * A helper may retire itself only on a settled answer. Everything else — the
 * server unreachable, a 500, a plain 401 — keeps it running, because tearing
 * a runtime down over a hiccup destroys a working agent.
 */
describe('a removed agent retires its own helper', () => {
  it('reads only a 403 agent_removed as proof of removal', () => {
    expect(isAgentRemovedError(new DaemonApiError('gone', 403, false, 'agent_removed'))).toBe(true);
    expect(isAgentRemovedError(new DaemonApiError('nope', 401, false, 'daemon_token_required'))).toBe(
      false,
    );
    expect(isAgentRemovedError(new DaemonApiError('forbidden', 403, false, 'request_failed'))).toBe(
      false,
    );
    expect(isAgentRemovedError(new DaemonApiError('boom', 500, true, 'agent_removed'))).toBe(false);
    expect(isAgentRemovedError(new TypeError('fetch failed'))).toBe(false);
  });

  it('stops the moment the server says the agent was removed', async () => {
    const { staged, config } = await stage('3');
    const execute = vi.fn(async () => {
      throw new DaemonApiError('monolith daemon request failed (403: agent_removed)', 403, false, 'agent_removed');
    });
    const core = new ThinDaemonCore(staged.runtime, staged.configPath, config, {
      daemonApi: { execute } as unknown as DaemonApiClient,
    });

    await expect(core.run({ pollMs: 1 })).resolves.toBe('agent-removed');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps running when it merely cannot reach the server', async () => {
    const { staged, config } = await stage('5');
    const failures = ['transport', '500', '401'];
    let attempt = 0;
    const execute = vi.fn(async () => {
      const kind = failures[attempt++ % failures.length];
      if (kind === 'transport') throw new TypeError('fetch failed');
      if (kind === '500') throw new DaemonApiError('server error', 503, true, 'request_failed');
      throw new DaemonApiError('unauthorized', 401, false, 'daemon_token_required');
    });
    const controller = new AbortController();
    const core = new ThinDaemonCore(staged.runtime, staged.configPath, config, {
      daemonApi: { execute } as unknown as DaemonApiClient,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const progress: string[] = [];
    const result = await core.run({
      pollMs: 1,
      signal: controller.signal,
      onProgress: (status) => {
        progress.push(status);
        if (progress.length >= failures.length) controller.abort();
      },
    });

    expect(result).toBe('aborted');
    expect(progress).toHaveLength(failures.length);
    expect(progress.every((status) => status.startsWith('monolith discovery degraded'))).toBe(true);
  });

  it('disables and resets its enabled unit from an ordinary caller before archiving', async () => {
    const { root, staged } = await stage('7');
    const service = `beeline-agent@${staged.runtime.agent.publicKey}.service`;
    const run = vi.fn(async (args: string[]) => ({ stdout: args[0] === 'show' ? 'loaded\n' : '' }));

    const archived = await retireRemovedAgent(staged.runtime, {
      // Reproduces a human/worker shell: the target unit is enabled, but the
      // caller did not inherit the daemon unit's environment marker.
      run,
    });

    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['show', '--property=LoadState', '--value', service],
      ['disable', service],
      ['reset-failed', service],
    ]);
    expect(archived.startsWith(resolve(root, 'beeline', 'deleted-runtimes'))).toBe(true);
    expect((await stat(archived)).isDirectory()).toBe(true);
    await expect(
      stat(runtimeDirectory(staged.runtime.supervisorRoot, staged.runtime.agent.publicKey)),
    ).rejects.toThrow();
    expect(await readdir(resolve(root, 'beeline', 'deleted-runtimes'))).toHaveLength(1);
  });

  it('moves a runtime when the exact target unit does not exist', async () => {
    const { staged } = await stage('e');
    const service = `beeline-agent@${staged.runtime.agent.publicKey}.service`;
    const run = vi.fn(async () => ({ stdout: 'not-found\n' }));

    await expect(
      retireRemovedAgent(staged.runtime, { run }),
    ).resolves.toContain(
      'deleted-runtimes',
    );
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['show', '--property=LoadState', '--value', service],
    ]);
  });

  it('cleans the unit before moving a runtime to another host root', async () => {
    const { root, staged } = await stage('c');
    const service = `beeline-agent@${staged.runtime.agent.publicKey}.service`;
    const target = resolve(root, 'review-rig', 'agents', staged.runtime.agent.publicKey);
    const run = vi.fn(async (args: string[]) => ({ stdout: args[0] === 'show' ? 'loaded\n' : '' }));

    await expect(
      relocateAgentRuntime(staged.runtime, target, { run }),
    ).resolves.toBe(target);
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ['show', '--property=LoadState', '--value', service],
      ['disable', service],
      ['reset-failed', service],
    ]);
    expect((await stat(target)).isDirectory()).toBe(true);
    await expect(
      stat(runtimeDirectory(staged.runtime.supervisorRoot, staged.runtime.agent.publicKey)),
    ).rejects.toThrow();
  });

  it.each(['disable', 'reset-failed'] as const)(
    'keeps the runtime in place when systemd %s fails',
    async (failedCommand) => {
      const { staged } = await stage(failedCommand === 'disable' ? 'a' : 'b');
      const service = `beeline-agent@${staged.runtime.agent.publicKey}.service`;
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === 'show') return { stdout: 'loaded\n' };
        if (args[0] === failedCommand) throw new Error(`${failedCommand} failed`);
        return { stdout: '' };
      });

      await expect(
        retireRemovedAgent(staged.runtime, { run }),
      ).rejects.toThrow(`${failedCommand} failed`);
      await expect(
        stat(runtimeDirectory(staged.runtime.supervisorRoot, staged.runtime.agent.publicKey)),
      ).resolves.toMatchObject({});
    },
  );

  it('retries reset-failed after disable already made the unit non-enabled', async () => {
    const { staged } = await stage('d');
    let resetAttempts = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'show') return { stdout: 'loaded\n' };
      if (args[0] === 'reset-failed' && ++resetAttempts === 1) {
        throw new Error('reset-failed failed');
      }
      return { stdout: '' };
    });

    await expect(
      retireRemovedAgent(staged.runtime, { run }),
    ).rejects.toThrow('reset-failed failed');
    await expect(
      retireRemovedAgent(staged.runtime, { run }),
    ).resolves.toContain('deleted-runtimes');
    expect(resetAttempts).toBe(2);
  });
});
