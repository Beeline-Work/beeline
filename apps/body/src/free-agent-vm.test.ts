import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgentEnv, parseEnvFile } from './config.js';
import { identityFromKey } from './runtime.js';
import {
  fetchFreeAgentGrant,
  freeAgentModelEnv,
  freeAgentOpenCodeConfig,
  requestFreeAgentSleep,
  type FreeAgentGrant,
} from './free-agent-vm.js';

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
  it('points OpenCode at the server proxy with only the scoped model token', async () => {
    const config = JSON.parse(freeAgentOpenCodeConfig(GRANT));
    expect(config.model).toBe('beeline/deepseek/deepseek-v4-flash');
    expect(config.provider.beeline.npm).toBe('@ai-sdk/openai-compatible');
    expect(config.provider.beeline.options).toEqual({
      baseURL: 'https://server.test/v1/free-agents/model',
      apiKey: '{env:BEELINE_FREE_AGENT_MODEL_TOKEN}',
    });
    expect(config.provider.beeline.models['deepseek/deepseek-v4-flash'].tool_call).toBe(true);

    const directory = await mkdtemp(join(tmpdir(), 'free-agent-env-'));
    try {
      const path = join(directory, 'model.env');
      await writeFile(path, freeAgentModelEnv(GRANT));
      const env = parseEnvFile(path);
      expect(env.BEELINE_FREE_AGENT_MODEL_TOKEN).toBe(GRANT.modelToken);
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual(config);
      expect(env.BUZZY_BODY_AGENT_ENV_PASSTHROUGH).toBe(
        'BEELINE_FREE_AGENT_MODEL_TOKEN,BEELINE_FREE_AGENT_MAX_TURN_SECONDS,OPENCODE_CONFIG_CONTENT,OPENCODE_DISABLE_AUTOUPDATE,OPENCODE_DISABLE_MODELS_FETCH',
      );
      // The helper's agent env carries the token and config to OpenCode.
      const agentEnv = buildAgentEnv({ PATH: '/usr/bin', HOME: '/root' }, path);
      expect(agentEnv.BEELINE_FREE_AGENT_MODEL_TOKEN).toBe(GRANT.modelToken);
      expect(agentEnv.BEELINE_FREE_AGENT_MAX_TURN_SECONDS).toBe('900');
      expect(agentEnv.OPENCODE_CONFIG_CONTENT).toBe(env.OPENCODE_CONFIG_CONTENT);
      expect(Object.values(env).join('\n')).not.toContain('sk-or-');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
