import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  outcomeFromReport,
  probeReleaseInSubprocess,
  runUpdateProbeCommand,
  UPDATE_PROBE_COMMAND,
} from './current-release-probe.js';
import { identityFromKey, writeRuntimeRecord, type AgentRuntimeRecord } from './runtime.js';
import type { BeelineInstallLayout } from './self-update.js';
import { UpdateFunctionalProbeError } from './update-functional-probe.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function layoutWithRelease(
  releaseId: string,
  entrypoint: string | undefined,
): Promise<BeelineInstallLayout> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-current-release-probe-'));
  roots.push(root);
  const layout = {
    binDir: resolve(root, 'bin'),
    libDir: resolve(root, 'lib/beeline'),
    releasesRoot: resolve(root, 'lib/beeline-releases'),
  };
  const bundle = resolve(layout.releasesRoot, releaseId, 'lib/beeline');
  await mkdir(bundle, { recursive: true });
  if (entrypoint !== undefined) {
    await writeFile(resolve(bundle, 'beeline-cli.mjs'), entrypoint);
  }
  return layout;
}

describe('probeReleaseInSubprocess', () => {
  it("reads the current release's refusal from its own update-probe report", async () => {
    const layout = await layoutWithRelease(
      'old',
      `const [command, flag, config] = process.argv.slice(2);
console.log('[body] openrouter routing for z-ai/glm-5.3-flash: deepinfra, novita');
if (command !== '${UPDATE_PROBE_COMMAND}' || flag !== '--config' || config !== '/runtime/runtime.json') {
  console.log(JSON.stringify({ probe: 'failed', reason: 'wrong argv ' + process.argv.slice(2).join(' ') }));
} else {
  console.log(JSON.stringify({ probe: 'refused', status: 404, reason: 'provider error 404: No endpoints found' }));
}
`,
    );
    await expect(
      probeReleaseInSubprocess({
        layout,
        releaseId: 'old',
        runtimeConfigPath: '/runtime/runtime.json',
      }),
    ).resolves.toEqual({
      kind: 'refused',
      status: 404,
      reason: 'provider error 404: No endpoints found',
    });
  });

  it('reads a served answer and a differently failed probe', async () => {
    const served = await layoutWithRelease(
      'old',
      `console.log(JSON.stringify({ probe: 'served' }));\n`,
    );
    await expect(
      probeReleaseInSubprocess({ layout: served, releaseId: 'old', runtimeConfigPath: '/r.json' }),
    ).resolves.toEqual({ kind: 'served' });
    const failed = await layoutWithRelease(
      'old',
      `console.log(JSON.stringify({ probe: 'failed', reason: 'session-start-failed: hung extension' }));\n`,
    );
    await expect(
      probeReleaseInSubprocess({ layout: failed, releaseId: 'old', runtimeConfigPath: '/r.json' }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'session-start-failed: hung extension' });
  });

  it('is unavailable for a release that predates the subcommand (usage, exit 1)', async () => {
    const layout = await layoutWithRelease(
      'old',
      `console.error('\\nBeeline — thin Room agent.\\n\\nUsage:\\n  beeline connect ...');\nprocess.exit(1);\n`,
    );
    const outcome = await probeReleaseInSubprocess({
      layout,
      releaseId: 'old',
      runtimeConfigPath: '/r.json',
    });
    expect(outcome.kind).toBe('unavailable');
    expect((outcome as { reason: string }).reason).toContain(
      'release old printed no probe report (exit 1)',
    );
    expect((outcome as { reason: string }).reason).toContain('Usage:');
  });

  it('is unavailable when the release hangs past the budget or has no entrypoint', async () => {
    const hung = await layoutWithRelease('old', `setInterval(() => {}, 1000);\n`);
    await expect(
      probeReleaseInSubprocess({
        layout: hung,
        releaseId: 'old',
        runtimeConfigPath: '/r.json',
        timeoutMs: 300,
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'release old did not finish its probe within 300ms',
    });
    const missing = await layoutWithRelease('old', undefined);
    await expect(
      probeReleaseInSubprocess({ layout: missing, releaseId: 'old', runtimeConfigPath: '/r.json' }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'release old has no runnable CLI entrypoint',
    });
  });

  it('maps every report shape to an outcome', () => {
    expect(outcomeFromReport({ probe: 'served' })).toEqual({ kind: 'served' });
    expect(outcomeFromReport({ probe: 'refused', status: 422, reason: 'x' })).toEqual({
      kind: 'refused',
      status: 422,
      reason: 'x',
    });
    expect(outcomeFromReport({ probe: 'failed', reason: 'y' })).toEqual({
      kind: 'unavailable',
      reason: 'y',
    });
  });
});

describe('runUpdateProbeCommand', () => {
  async function runtimeRecord(): Promise<{ configPath: string; supervisorRoot: string }> {
    const supervisorRoot = await mkdtemp(join(tmpdir(), 'beeline-update-probe-cmd-'));
    roots.push(supervisorRoot);
    const stored = (name: string) => {
      const identity = identityFromKey(undefined, name);
      return {
        name,
        secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
        publicKey: identity.publicKey,
      };
    };
    const fakeAgent = join(supervisorRoot, 'pi-acp');
    await writeFile(fakeAgent, '#!/bin/sh\nexit 0\n');
    await chmod(fakeAgent, 0o755);
    const runtime: AgentRuntimeRecord = {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: stored('agent'),
      body: stored('body'),
      rooms: [],
      supervisorRoot,
      transport: { kind: 'monolith', baseUrl: 'http://127.0.0.1:1', daemonToken: `bdt_${'x'.repeat(43)}` },
      agentBinary: fakeAgent,
      agentCommand: fakeAgent,
      agentKind: 'pi',
      agentArgs: [],
      mcpBinary: 'buzz-dev-mcp',
      modelSelection: { model: 'openrouter/z-ai/glm-5.3-flash' },
      sandbox: 'off',
      createdAt: new Date(0).toISOString(),
    };
    return { configPath: await writeRuntimeRecord(runtime), supervisorRoot };
  }

  const env = { PATH: process.env.PATH ?? '', HOME: tmpdir(), BUZZY_BODY_SANDBOX: 'off' };

  it("runs this bundle's probe against the runtime record and prints one report line", async () => {
    const { configPath } = await runtimeRecord();
    const lines: string[] = [];
    const probe = vi.fn(async () => ({
      harness: 'pi',
      sandboxed: false,
      sessionStarted: true as const,
      turnCompleted: true as const,
      nativeTools: [] as const,
      modelAnswer: 'served' as const,
    }));
    await runUpdateProbeCommand(['--config', configPath], {
      env,
      write: (line) => lines.push(line),
      probe,
    });
    expect(lines).toEqual(['{"probe":"served"}']);
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeDir: dirname(configPath),
        probeRoot: join(dirname(configPath), 'current-release-probe'),
        sandboxRequired: false,
        config: expect.objectContaining({
          agentKind: 'pi',
          modelSelection: { model: 'openrouter/z-ai/glm-5.3-flash' },
          runtimeConfigPath: configPath,
        }),
      }),
    );
  });

  it('reports a provider refusal with its status and any other failure as failed', async () => {
    const { configPath } = await runtimeRecord();
    const lines: string[] = [];
    await runUpdateProbeCommand(['--config', configPath], {
      env,
      write: (line) => lines.push(line),
      probe: async () => {
        throw new UpdateFunctionalProbeError('turn-failed', 'no answer', {
          providerRefusal: { status: 404, reason: 'provider error 404: No endpoints found' },
        });
      },
    });
    await runUpdateProbeCommand(['--config', configPath], {
      env,
      write: (line) => lines.push(line),
      probe: async () => {
        throw new UpdateFunctionalProbeError('session-start-failed', 'hung extension');
      },
    });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { probe: 'refused', status: 404, reason: 'provider error 404: No endpoints found' },
      {
        probe: 'failed',
        reason: 'functional update probe failed (session-start-failed): hung extension',
      },
    ]);
  });

  it('requires --config', async () => {
    await expect(runUpdateProbeCommand([], { env, write: () => undefined })).rejects.toThrow(
      'update-probe requires --config <runtime.json>',
    );
  });
});
