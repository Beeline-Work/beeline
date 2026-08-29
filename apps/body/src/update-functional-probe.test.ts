import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BodyConfig } from './config.js';
import { runUpdateFunctionalProbe, UpdateFunctionalProbeError } from './update-functional-probe.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureConfig(mode: 'clean' | 'hang' = 'clean'): Promise<{
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
import readline from 'node:readline';
const mode = process.argv[2];
let server;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return reply(message.id, { agentCapabilities: {} });
  if (message.method === 'session/new') {
    server = message.params.mcpServers[0];
    if (mode !== 'hang') reply(message.id, { sessionId: 'probe-session', configOptions: [] });
    return;
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
      if (response.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_mandate', arguments: {} } }) + '\\n');
      if (response.id === 2) {
        child.kill();
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
  return {
    runtimeDir,
    proxyEntrypoint,
    config: {
      agentBinary: process.execPath,
      agentKind: 'custom',
      agentCommand: process.execPath,
      agentArgs: [harness, mode],
      mcpBinary: process.execPath,
      agentEnv: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? runtimeDir,
        TMPDIR: tmpdir(),
      },
      workspaceRoot: runtimeDir,
      relayBaseUrl: 'https://example.invalid',
      relayHost: 'example.invalid',
      relayScheme: 'https',
      relayWsUrl: 'wss://example.invalid',
      autoApprovePermissions: true,
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
        nativeTools: ['read_mandate'],
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
});
