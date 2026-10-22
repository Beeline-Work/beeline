import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runMachineHelper } from './machine-helper.js';
import { buildAgentEnv, parseEnvFile } from './config.js';
import { identityFromKey, readRuntimeRecord, runtimeConfigPath, writeRuntimeRecord } from './runtime.js';
import {
  fetchFreeAgentGrant,
  freeAgentModelEnv,
  freeAgentPiConfig,
  requestFreeAgentSleep,
  runFreeAgentCommand,
  type FreeAgentGrant,
} from './free-agent-vm.js';

vi.mock('./machine-helper.js', () => ({ runMachineHelper: vi.fn(async () => undefined) }));

const GRANT: FreeAgentGrant = {
  agentId: 'a'.repeat(64),
  agentSecretKey: 'b'.repeat(64),
  bodySecretKey: 'c'.repeat(64),
  agentName: 'Fern',
  harness: 'opencode',
  model: 'beeline/deepseek/deepseek-v4-flash',
  soul: 'soul',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  workspaceName: 'Hive',
  pairedBy: 'd'.repeat(64),
  monolithBaseUrl: 'https://server.test',
  daemonExchangeToken: `bde_${'e'.repeat(43)}`,
  modelToken: `bfm_${'f'.repeat(43)}`,
  modelBaseUrl: 'https://server.test/v1/free-agents/model',
  upstreamModel: 'deepseek/deepseek-v4-flash',
  idleSeconds: 60,
};

describe('free agent Machine entry', () => {
  it('points Pi at the scoped proxy with bounded output and an env-only key', async () => {
    const config = JSON.parse(freeAgentPiConfig(GRANT));
    const provider = config.providers.beeline;
    expect(provider.baseUrl).toBe(GRANT.modelBaseUrl);
    expect(provider.api).toBe('openai-completions');
    expect(provider.apiKey).toBe('$BEELINE_FREE_AGENT_MODEL_TOKEN');
    expect(provider.models[0]).toMatchObject({
      id: GRANT.upstreamModel, contextWindow: 1_000_000, maxTokens: 65_536,
    });
    expect(provider.models[0].maxTokens).toBeLessThan(provider.models[0].contextWindow / 10);
    expect(JSON.stringify(config)).not.toContain(GRANT.modelToken);
    const directory = await mkdtemp(join(tmpdir(), 'free-agent-env-'));
    try {
      const path = join(directory, 'model.env');
      await writeFile(path, freeAgentModelEnv(GRANT));
      const env = parseEnvFile(path);
      expect(env.BEELINE_FREE_AGENT_MODEL_TOKEN).toBe(GRANT.modelToken);
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      const agentEnv = buildAgentEnv({ PATH: '/usr/bin', HOME: '/root' }, path);
      expect(agentEnv.BEELINE_FREE_AGENT_MODEL_TOKEN).toBe(GRANT.modelToken);
      expect(agentEnv.BEELINE_FREE_AGENT_MAX_TURN_SECONDS).toBe('900');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('upgrades an existing OpenCode runtime before its next helper boot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-agent-upgrade-'));
    try {
      const binary = join(root, 'bin');
      await mkdir(binary);
      for (const name of ['pi', 'pi-acp']) {
        await writeFile(join(binary, name), '#!/bin/sh\nexit 0\n');
        await chmod(join(binary, name), 0o700);
      }
      const envFile = join(root, 'model.env');
      const legacy = { provider: { beeline: { options: { baseURL: GRANT.modelBaseUrl } } } };
      await writeFile(envFile, `BEELINE_FREE_AGENT_MODEL_TOKEN=${GRANT.modelToken}\nOPENCODE_CONFIG_CONTENT=${JSON.stringify(legacy)}\n`);
      const stored = (secret: string) => ({
        name: 'test', secretKeyHex: secret, publicKey: identityFromKey(secret, 'test').publicKey,
      });
      const agent = stored('1'.repeat(64));
      await writeRuntimeRecord({
        version: 2, communityId: GRANT.workspaceId, pairedBy: GRANT.pairedBy,
        agent, body: stored('2'.repeat(64)), rooms: [], supervisorRoot: root,
        agentKind: 'opencode', agentBinary: 'opencode', agentCommand: 'opencode',
        agentArgs: ['acp'], mcpBinary: 'beeline-readonly-mcp', llmEnvFile: envFile,
        modelSelection: { model: GRANT.model },
        transport: { kind: 'monolith', baseUrl: GRANT.monolithBaseUrl, daemonToken: 'bdt_test' },
      });
      const path = runtimeConfigPath(root, agent.publicKey);
      const env = { HOME: root, PATH: binary, XDG_STATE_HOME: root,
        BEELINE_FREE_AGENT_ID: agent.publicKey, BEELINE_SERVER_URL: GRANT.monolithBaseUrl };
      await mkdir(join(root, 'beeline/free-agent'), { recursive: true });
      await writeFile(join(root, 'beeline/free-agent/settings.json'), JSON.stringify({ idleSeconds: 60 }));
      await runFreeAgentCommand(env);
      const runtime = await readRuntimeRecord(path);
      expect(runtime).toMatchObject({ agentKind: 'pi', agentCommand: join(binary, 'pi-acp'), agentArgs: [] });
      expect(runtime.transport).toMatchObject({ daemonToken: 'bdt_test' });
      expect(JSON.parse(await readFile(join(root, '.pi/agent/models.json'), 'utf8'))).toEqual(JSON.parse(freeAgentPiConfig(GRANT)));
      expect(parseEnvFile(envFile).OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(runMachineHelper).toHaveBeenCalledWith(expect.objectContaining({ configPaths: [path] }));
      await runFreeAgentCommand(env);
      expect((await readRuntimeRecord(path)).agentKind).toBe('pi');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('boots a persisted Pi runtime from the legacy release and authenticates a child model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-agent-legacy-pi-'));
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      requests.push(request.headers.authorization ?? '');
      for await (const _ of request) { /* Consume the model request. */ }
      if (request.headers.authorization !== `Bearer ${GRANT.modelToken}`) {
        response.writeHead(401).end('Authentication required');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'UPGRADE_ENV_PROOF_OK' } }] }));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
      const stored = (secret: string) => ({
        name: 'test', secretKeyHex: secret, publicKey: identityFromKey(secret, 'test').publicKey,
      });
      const agent = stored('1'.repeat(64));
      const envFile = join(root, 'model.env');
      // The persisted allowlist name emitted by release 6d908054.
      await writeFile(envFile, `BEELINE_FREE_AGENT_MODEL_TOKEN=${GRANT.modelToken}\n` +
        'BEELINE_FREE_AGENT_MAX_TURN_SECONDS=321\n' +
        'BUZZY_BODY_AGENT_ENV_PASSTHROUGH=BEELINE_FREE_AGENT_MODEL_TOKEN,BEELINE_FREE_AGENT_MAX_TURN_SECONDS,BUZZY_CUSTOM\n' +
        'BUZZY_CUSTOM=preserved\nUNRELATED_SETTING=keep\n');
      await writeRuntimeRecord({
        version: 2, communityId: GRANT.workspaceId, pairedBy: GRANT.pairedBy,
        agent, body: stored('2'.repeat(64)), rooms: [], supervisorRoot: root,
        agentKind: 'pi', agentBinary: 'pi-acp', agentCommand: 'pi-acp', agentArgs: [],
        mcpBinary: 'beeline-readonly-mcp', llmEnvFile: envFile,
        modelSelection: { model: GRANT.model },
        transport: { kind: 'monolith', baseUrl: GRANT.monolithBaseUrl, daemonToken: 'bdt_test' },
      });
      await mkdir(join(root, 'beeline/free-agent'), { recursive: true });
      await writeFile(join(root, 'beeline/free-agent/settings.json'), JSON.stringify({ idleSeconds: 60 }));
      const env = { HOME: root, PATH: process.env.PATH, XDG_STATE_HOME: root,
        BEELINE_FREE_AGENT_ID: agent.publicKey, BEELINE_SERVER_URL: GRANT.monolithBaseUrl };
      await runFreeAgentCommand(env);
      const reconciled = await readFile(envFile, 'utf8');
      const parsed = parseEnvFile(envFile);
      expect(parsed.BUZZY_BODY_AGENT_ENV_PASSTHROUGH).toBeUndefined();
      expect(parsed).toMatchObject({ BEELINE_CUSTOM: 'preserved', UNRELATED_SETTING: 'keep' });
      const childEnv = buildAgentEnv(env, envFile);
      expect(childEnv.BEELINE_CUSTOM).toBe('preserved');
      expect(childEnv.BEELINE_FREE_AGENT_MAX_TURN_SECONDS).toBe('321');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('model server did not bind');
      const script = `const response = await fetch('http://127.0.0.1:${address.port}/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer ' + process.env.BEELINE_FREE_AGENT_MODEL_TOKEN },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply hello' }] }) });
        if (!response.ok) throw new Error(await response.text());
        console.log((await response.json()).choices[0].message.content);`;
      const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: childEnv });
      expect(child.stdout.trim()).toBe('UPGRADE_ENV_PROOF_OK');
      expect(requests).toEqual([`Bearer ${GRANT.modelToken}`]);
      await runFreeAgentCommand(env);
      expect(await readFile(envFile, 'utf8')).toBe(reconciled);
      expect((await readRuntimeRecord(runtimeConfigPath(root, agent.publicKey))).agentKind).toBe('pi');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pins both image tools and matches the persisted-Machine installer', async () => {
    const dockerfile = await readFile(new URL('../../../infra/free-agent/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('ARG PI_VERSION=0.84.3');
    expect(dockerfile).toContain('ARG PI_ACP_VERSION=0.0.34');
    expect(dockerfile).not.toMatch(/ARG \w+=latest/);
    expect(dockerfile).not.toContain('opencode-ai');
    const installer = await readFile(new URL('./free-agent-vm.ts', import.meta.url), 'utf8');
    expect(installer).not.toContain("['install', '-g'");
    expect(installer).toContain("resolveAgentCommand({ kind: 'pi', env })");
  });

  it('retries a failed bootstrap and stops on a refused token', async () => {
    const calls: string[] = [];
    const responses = [new Response('busy', { status: 503 }), Response.json(GRANT)];
    const grant = await fetchFreeAgentGrant(
      'https://server.test',
      'bfb_token',
      (async (url: string | URL, init?: RequestInit) => {
        calls.push(`${String(url)} ${String(init?.body)}`);
        return responses.shift()!;
      }) as typeof fetch,
      async () => undefined,
    );
    expect(grant.agentId).toBe(GRANT.agentId);
    expect(calls).toEqual([
      'https://server.test/v1/free-agents/bootstrap {"token":"bfb_token"}',
      'https://server.test/v1/free-agents/bootstrap {"token":"bfb_token"}',
    ]);
    await expect(
      fetchFreeAgentGrant(
        'https://server.test',
        'bfb_token',
        (async () => new Response('no', { status: 401 })) as typeof fetch,
        async () => undefined,
      ),
    ).rejects.toThrow('refused');
  });

  it('reports idleness with its own daemon token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-agent-runtime-'));
    try {
      const path = join(root, 'runtime.json');
      await mkdir(root, { recursive: true });
      const stored = (secret: string) => {
        const identity = identityFromKey(secret, 'x');
        return { name: 'x', secretKeyHex: secret, publicKey: identity.publicKey };
      };
      await writeFile(
        path,
        JSON.stringify({
          version: 2,
          communityId: GRANT.workspaceId,
          agent: stored('1'.repeat(64)),
          body: stored('2'.repeat(64)),
          transport: { kind: 'monolith', baseUrl: 'https://server.test', daemonToken: `bdt_${'g'.repeat(43)}` },
        }),
      );
      const seen: Array<{ url: string; authorization: string | null }> = [];
      const seenBodies: string[] = [];
      const accepted = await requestFreeAgentSleep(path, { refresh: true }, (async (url: string | URL, init?: RequestInit) => {
        seen.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
        seenBodies.push(String(init?.body));
        return Response.json({ sleep: true });
      }) as typeof fetch);
      expect(accepted).toBe(true);
      expect(seen).toEqual([
        { url: 'https://server.test/v1/free-agents/sleep', authorization: `Bearer bdt_${'g'.repeat(43)}` },
      ]);
      expect(seenBodies).toEqual(['{"refresh":true}']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
