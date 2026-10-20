import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readEnv, envPair } from './env.js';
import { buildAgentEnv, loadBodyConfig, parseSandboxMaskEnv } from './config.js';
import {
  resolveMaxWarmSessions,
  resolvePerRoomLiveSessions,
  resolveSessionIdleMs,
} from './session-scheduler.js';
import { detectBwrapSandbox } from './bwrap-sandbox.js';
import { harnessStateDirsFromEnv } from './agent-home.js';
import { freeAgentModelEnv } from './free-agent-vm.js';

const suffixes = [
  'BODY_SANDBOX',
  'BODY_SANDBOX_MASK',
  'BODY_AGENT_ENV_PASSTHROUGH',
  'BODY_AGENT_ENV_INHERIT',
  'BODY_MAX_SESSIONS',
  'BODY_MAX_SESSIONS_FLOOR',
  'BODY_MAX_SESSIONS_PER_ROOM',
  'BODY_MAX_WARM_SESSIONS',
  'BODY_SESSION_IDLE_MS',
  'BODY_ROOM_HOME',
  'BODY_AGENT_DELEGATION_MAX_HOPS',
  'BODY_AUTO_APPROVE',
  'AGENT_PRIVATE_DIR',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'RELAY_HOST',
  'RELAY_SCHEME',
  'RELAY_URL',
];

describe.each(suffixes)('%s compatibility', (suffix) => {
  it('uses old values, prefers new values, and preserves empty overrides', () => {
    expect(readEnv({ ['BUZZY_' + suffix]: 'old' }, suffix)).toBe('old');
    expect(readEnv({ ['BUZZY_' + suffix]: 'old', ['BEELINE_' + suffix]: 'new' }, suffix)).toBe(
      'new',
    );
    expect(readEnv({ ['BUZZY_' + suffix]: 'old', ['BEELINE_' + suffix]: '' }, suffix)).toBe('');
    expect(readEnv({}, suffix)).toBeUndefined();
  });
  it('exports both spellings to older children with the resolved value', () => {
    for (const prefix of ['BEELINE_', 'BUZZY_']) {
      expect(buildAgentEnv({ [prefix + suffix]: 'chosen' })).toMatchObject(
        envPair(suffix, 'chosen'),
      );
    }
    expect(
      buildAgentEnv({ ['BEELINE_' + suffix]: 'new', ['BUZZY_' + suffix]: 'old' }),
    ).toMatchObject(envPair(suffix, 'new'));
  });
});

describe.each(['BEELINE_', 'BUZZY_'])('%s operator config path', (prefix) => {
  const env = (suffix: string, value: string) => ({
    ...(prefix === 'BEELINE_' ? { ['BUZZY_' + suffix]: 'wrong' } : {}),
    [prefix + suffix]: value,
  });
  it('configures the actual sandbox, scheduler, private state and agent environment', () => {
    expect(parseSandboxMaskEnv(env('BODY_SANDBOX_MASK', '/srv/mask'))).toEqual(['/srv/mask']);
    expect(resolveMaxWarmSessions(env('BODY_MAX_WARM_SESSIONS', '3'))).toBe(3);
    expect(resolvePerRoomLiveSessions(env('BODY_MAX_SESSIONS_PER_ROOM', '7'))).toBe(7);
    expect(resolveSessionIdleMs(env('BODY_SESSION_IDLE_MS', '90000'))).toBe(90000);
    expect(
      detectBwrapSandbox({ policy: 'bwrap', env: env('BODY_SANDBOX', 'off') }).advisory,
    ).toMatch(/DISABLED by configuration/);
    expect(harnessStateDirsFromEnv(env('AGENT_PRIVATE_DIR', '/srv/private')).stateDirs).toContain(
      '/srv/private',
    );
    const config = loadBodyConfig({
      workspaceRoot: '/tmp/workspace',
      env: {
        BUZZ_AGENT_BIN: process.execPath,
        BUZZ_DEV_MCP_BIN: process.execPath,
        BEELINE_READONLY_MCP_BIN: process.execPath,
        BEELINE_HARNESS_PATH_AUGMENT: '0',
        ...env('BODY_AGENT_DELEGATION_MAX_HOPS', '2'),
        ...env('BODY_AUTO_APPROVE', '0'),
      },
    });
    expect(config.agentDelegationMaxHops).toBe(2);
    expect(config.autoApprovePermissions).toBe(false);
    expect(
      buildAgentEnv({
        ...env('LLM_API_KEY', 'fixture-key'),
        ...env('LLM_MODEL', 'fixture-model'),
        ...env('LLM_BASE_URL', 'https://model.example/v1'),
        ...env('BODY_AGENT_ENV_PASSTHROUGH', 'EXTRA_VALUE'),
        EXTRA_VALUE: 'fixture',
      }),
    ).toMatchObject({
      OPENAI_COMPAT_API_KEY: 'fixture-key',
      OPENAI_COMPAT_MODEL: 'fixture-model',
      OPENAI_COMPAT_BASE_URL: 'https://model.example/v1',
      EXTRA_VALUE: 'fixture',
    });
  });
});

it('writes both names in free-agent model files', () => {
  const text = freeAgentModelEnv({ modelToken: 'fixture' });
  for (const prefix of ['BEELINE_', 'BUZZY_']) {
    expect(text).toContain(
      prefix +
        'BODY_AGENT_ENV_PASSTHROUGH=BEELINE_FREE_AGENT_MODEL_TOKEN,BEELINE_FREE_AGENT_MAX_TURN_SECONDS\n',
    );
  }
});

it.each(['BEELINE_', 'BUZZY_'])('reads the operator LLM file using %s names', (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), 'beeline-env-fixture-'));
  const file = join(dir, 'model.env');
  try {
    writeFileSync(
      file,
      prefix +
        'LLM_API_KEY=file-key\n' +
        prefix +
        'LLM_MODEL=file-model\n' +
        prefix +
        'LLM_BASE_URL=https://file.example/v1\n',
    );
    expect(buildAgentEnv({ [prefix + 'LLM_API_KEY']: 'ambient' }, file)).toMatchObject({
      OPENAI_COMPAT_API_KEY: 'file-key',
      OPENAI_COMPAT_MODEL: 'file-model',
      OPENAI_COMPAT_BASE_URL: 'https://file.example/v1',
      BEELINE_LLM_API_KEY: 'file-key',
      BUZZY_LLM_API_KEY: 'file-key',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['BEELINE_', 'BUZZY_'])(
  'live config exports both relay spellings from %s',
  async (prefix) => {
    try {
      vi.resetModules();
      for (const suffix of ['RELAY_HOST', 'RELAY_SCHEME', 'RELAY_URL']) {
        vi.stubEnv('BEELINE_' + suffix, undefined);
        vi.stubEnv('BUZZY_' + suffix, undefined);
        vi.stubEnv(prefix + suffix, 'fixture');
      }
      await import('../vitest.live.config.js');
      for (const suffix of ['RELAY_HOST', 'RELAY_SCHEME', 'RELAY_URL']) {
        expect(process.env['BEELINE_' + suffix]).toBe('fixture');
        expect(process.env['BUZZY_' + suffix]).toBe('fixture');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
