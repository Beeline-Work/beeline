import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BodyConfig } from './config.js';
import { runUpdateFunctionalProbe, UpdateFunctionalProbeError } from './update-functional-probe.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureConfig(mode: 'clean' | 'hang' | 'silent' | 'pi-cold-start' = 'clean'): Promise<{
  config: BodyConfig;
  runtimeDir: string;
  proxyEntrypoint: string;
}> {
  const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-update-probe-'));
  roots.push(runtimeDir);
  const harness = resolve(runtimeDir, 'fixture-acp.mjs');
  const proxyEntrypoint = resolve(runtimeDir, 'fixture-mcp-proxy.mjs');
  await writeFile(
    proxyEntrypoint,
    `import net from 'node:net';
import readline from 'node:readline';
const [, , host, port, token] = process.argv;
const socket = net.connect(Number(port), host, () => socket.write(JSON.stringify({ token }) + '\\n'));
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => socket.write(line + '\\n'));
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    process.stdout.write(buffer.slice(0, newline + 1));
    buffer = buffer.slice(newline + 1);
  }
});
`,
    { mode: 0o700 },
  );
  await writeFile(
    harness,
    `import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';
const mode = process.argv[2];
const expectedGrokArgs = process.env.EXPECT_GROK_ARGS
  ? JSON.parse(process.env.EXPECT_GROK_ARGS)
  : undefined;
if (expectedGrokArgs && JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedGrokArgs)) {
  process.exit(35);
}
let server;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return reply(message.id, { agentCapabilities: {} });
  if (message.method === 'session/new') {
    server = message.params.mcpServers[0];
    if (expectedGrokArgs) {
      return reply(message.id, {
        sessionId: 'probe-session',
        models: {
          currentModelId: 'grok-4.5',
          availableModels: [
            {
              modelId: 'grok-4.5',
              name: 'Grok 4.5',
              _meta: {
                reasoningEffort: 'medium',
                reasoningEfforts: [{ value: 'medium', label: 'Medium' }],
              },
            },
          ],
        },
      });
    }
    if (mode === 'pi-cold-start') {
      const piDir = process.env.PI_CODING_AGENT_DIR;
      const models = JSON.parse(readFileSync(resolve(piDir, 'models.json'), 'utf8'));
      if (models.providers?.['openrouter-ox']?.models?.[0]?.contextWindow !== 98304) process.exit(31);
      if (!models.providers?.openrouter || process.env.MCP_DIRECT_TOOLS !== server.name) process.exit(32);
      if (piDir === process.env.STALE_PI_DIR || existsSync(resolve(piDir, 'stale-adapter.mjs'))) process.exit(33);
      if (!existsSync(resolve(piDir, 'extensions', 'beeline-pi-mcp-adapter.mjs'))) process.exit(34);
      setTimeout(() => reply(message.id, { sessionId: 'probe-session', configOptions: [] }), 750);
    } else if (mode !== 'hang') reply(message.id, { sessionId: 'probe-session', configOptions: [] });
    return;
  }
  if (message.method === 'session/set_model') {
    if (message.params.sessionId !== 'probe-session' || message.params.modelId !== 'grok-4.5') {
      process.exit(36);
    }
    return reply(message.id, {});
  }
  if (message.method !== 'session/prompt') return;
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries((server.env || []).map((entry) => [entry.name, entry.value])) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\\n')) >= 0) {
      const response = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (response.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'close_corner', arguments: { corner_id: 'update-probe' } } }) + '\\n');
      if (response.id === 2) {
        child.kill();
        if (mode !== 'silent') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'probe-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READY' } }
        } }) + '\\n');
        reply(message.id, { stopReason: 'end_turn' });
      }
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n');
});
`,
    { mode: 0o700 },
  );
  await chmod(harness, 0o700);
  const operatorHome = resolve(runtimeDir, 'operator-home');
  if (mode === 'pi-cold-start') {
    await mkdir(resolve(operatorHome, '.pi/agent'), { recursive: true });
    await writeFile(resolve(operatorHome, '.pi/agent/auth.json'), '{}\n', { mode: 0o600 });
    await writeFile(
      resolve(operatorHome, '.pi/agent/models.json'),
      JSON.stringify({
        providers: {
          openrouter: {
            api: 'openai-completions',
            apiKey: 'fixture-secret',
            models: [{ id: 'z-ai/glm-5.3-flash', contextWindow: 98_304 }],
          },
          'openrouter-ox': {
            api: 'openai-completions',
            apiKey: 'fixture-secret',
            models: [{ id: 'z-ai/glm-5.3-flash', contextWindow: 98_304 }],
          },
        },
      }),
      { mode: 0o600 },
    );
  }
  const stalePiDir = resolve(runtimeDir, 'rooms/ox/agent-home/pi');
  if (mode === 'pi-cold-start') {
    await mkdir(resolve(stalePiDir, 'sessions/old/extensions'), { recursive: true });
    await mkdir(resolve(runtimeDir, 'rooms/ox/agent-home/tmp/jiti'), { recursive: true });
    await writeFile(resolve(stalePiDir, 'stale-adapter.mjs'), 'old release bytes\n');
    await writeFile(resolve(stalePiDir, 'sessions/old/mcp-cache.json'), '{}\n');
  }
  return {
    runtimeDir,
    proxyEntrypoint,
    config: {
      agentBinary: process.execPath,
      agentKind: mode === 'pi-cold-start' ? 'pi' : 'custom',
      agentCommand: process.execPath,
      agentArgs: [harness, mode],
      mcpBinary: process.execPath,
      agentEnv: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? runtimeDir,
        TMPDIR: tmpdir(),
        ...(mode === 'pi-cold-start' ? { STALE_PI_DIR: stalePiDir } : {}),
      },
      workspaceRoot: runtimeDir,
      relayBaseUrl: 'https://example.invalid',
      relayHost: 'example.invalid',
      relayScheme: 'https',
      relayWsUrl: 'wss://example.invalid',
      autoApprovePermissions: true,
      ...(mode === 'pi-cold-start' ? { operatorHome } : {}),
    },
  };
}

describe('functional update probe', () => {
  it('requires session/new, one turn, and the native Beeline mount before READY', async () => {
    const fixture = await fixtureConfig();
    await expect(
      runUpdateFunctionalProbe({
        ...fixture,
        releaseId: 'clean-release',
        sandboxRequired: false,
        sessionTimeoutMs: 3_000,
        turnTimeoutMs: 3_000,
      }),
    ).resolves.toMatchObject(
      {
        sessionStarted: true,
        turnCompleted: true,
        nativeTools: ['close_corner'],
      },
      10_000,
    );
  });

  it('rejects an invalid persisted model before spawning a session', async () => {
    const fixture = await fixtureConfig();
    fixture.config.modelUnavailable = {
      reason: 'not-advertised',
      detail: 'configured model is no longer advertised',
      selection: { model: 'retired-model' },
    };
    await expect(
      runUpdateFunctionalProbe({
        ...fixture,
        releaseId: 'bad-model',
        sandboxRequired: false,
      }),
    ).rejects.toMatchObject({ reason: 'model-unavailable' });
  });

  it('rejects a broken required sandbox before spawning a session', async () => {
    const fixture = await fixtureConfig();
    await expect(
      runUpdateFunctionalProbe({
        ...fixture,
        releaseId: 'bad-sandbox',
        sandboxRequired: true,
      }),
    ).rejects.toMatchObject({ reason: 'sandbox-unavailable' });
  });

  it('turns a hung session/new into a typed bounded startup failure', async () => {
    const fixture = await fixtureConfig('hang');
    const startedAt = Date.now();
    await expect(
      runUpdateFunctionalProbe({
        ...fixture,
        releaseId: 'hung-extension',
        sandboxRequired: false,
        sessionTimeoutMs: 25,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<UpdateFunctionalProbeError>>({
        code: 'BEELINE_UPDATE_FUNCTIONAL_PROBE_FAILED',
        reason: 'session-start-failed',
      }),
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('rejects a completed protocol exchange that did not serve an agent answer', async () => {
    const fixture = await fixtureConfig('silent');
    await expect(
      runUpdateFunctionalProbe({
        ...fixture,
        releaseId: 'silent-turn',
        sandboxRequired: false,
        sessionTimeoutMs: 3_000,
        turnTimeoutMs: 3_000,
      }),
    ).rejects.toMatchObject({ reason: 'turn-failed' });
  });

  it('gives a production-shaped Pi cold session its own startup budget', async () => {
    const fixture = await fixtureConfig('pi-cold-start');
    await expect(
      runUpdateFunctionalProbe({
        ...fixture,
        releaseId: 'pi-custom-provider',
        sandboxRequired: false,
        sessionTimeoutMs: 500,
        sessionOpenTimeoutMs: 1_500,
        turnTimeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({
      harness: 'pi',
      sessionStarted: true,
      turnCompleted: true,
      nativeTools: ['close_corner'],
    });
  });

  it('preserves selected Grok launch args inside the bubblewrap command', async () => {
    const fixture = await fixtureConfig();
    const fakeBwrap = resolve(fixture.runtimeDir, 'fake-bwrap');
    await writeFile(
      fakeBwrap,
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    exec "$@"
  fi
  shift
done
exit 64
`,
      { mode: 0o700 },
    );
    await chmod(fakeBwrap, 0o700);
    const harness = fixture.config.agentArgs![0]!;
    fixture.config = {
      ...fixture.config,
      agentKind: 'grok',
      agentArgs: [harness, 'agent', 'stdio'],
      agentEnv: {
        ...fixture.config.agentEnv,
        EXPECT_GROK_ARGS: JSON.stringify([
          'agent',
          '--model',
          'grok-4.5',
          '--reasoning-effort',
          'medium',
          'stdio',
        ]),
      },
      bwrapPath: fakeBwrap,
      modelSelection: { model: 'grok-4.5', effort: 'medium' },
    };

    await expect(
      runUpdateFunctionalProbe({
        ...fixture,
        releaseId: 'grok-sandboxed-selection',
        sandboxRequired: true,
        sessionTimeoutMs: 3_000,
        turnTimeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ sandboxed: true, sessionStarted: true, turnCompleted: true });
  });
});
