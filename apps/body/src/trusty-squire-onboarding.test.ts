import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertTrustySquireConnectSupported,
  connectTrustySquireForPair,
  ensureTrustySquireSkill,
} from './trusty-squire-onboarding.js';
import {
  trustySquireConfigRoot,
  trustySquireConfigRootForRuntimeConfig,
} from './trusty-squire-storage.js';

const cleanup: string[] = [];
function scratch(prefix: string): string {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Trusty Squire pair-time onboarding', () => {
  it('runs the idempotent upstream connect flow on the operator machine and loads the skill', async () => {
    const operatorHome = scratch('squire-operator-home-');
    const configRoot = resolve(operatorHome, 'runtime', 'squire-config');
    const calls: Array<{
      command: string;
      args: readonly string[];
      timeoutMs: number;
      env: NodeJS.ProcessEnv;
    }> = [];
    const result = await connectTrustySquireForPair({
      agentKind: 'codex',
      operatorHome,
      configRoot,
      run: async (command, args, timeoutMs, env) => calls.push({ command, args, timeoutMs, env }),
    });

    expect(calls).toEqual([
      {
        command: 'npx',
        args: ['-y', '@trusty-squire/mcp@1.1.12', 'connect', '--target=codex', '--no-interactive'],
        timeoutMs: 30 * 60_000,
        env: expect.objectContaining({
          XDG_CONFIG_HOME: configRoot,
          TRUSTY_SQUIRE_SESSION_FILE: '1',
          TRUSTY_SQUIRE_SKIP_VERSION_CHECK: '1',
        }),
      },
    ]);
    expect(result.skillPath).toContain('.codex/skills/trusty-squire/SKILL.md');
    expect(await readFile(result.skillPath, 'utf8')).toContain('name: trusty-squire');
    expect(
      await readFile(
        resolve(operatorHome, '.agents', 'skills', 'trusty-squire', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('name: trusty-squire');
  });

  it('preserves an existing operator-owned skill and rejects an ungovernable harness', async () => {
    const operatorHome = scratch('squire-operator-home-');
    const path = await ensureTrustySquireSkill(operatorHome);
    await writeFile(path, 'operator copy\n');
    await ensureTrustySquireSkill(operatorHome);
    expect(await readFile(path, 'utf8')).toBe('operator copy\n');
    expect(() => assertTrustySquireConnectSupported('pi')).toThrow(/cannot enforce the P1/);
    expect(() => assertTrustySquireConnectSupported('goose')).toThrow(/cannot enforce the P1/);
  });

  it('reuses one machine-local store across pair retries and supported agents', async () => {
    const supervisorRoot = scratch('squire-supervisor-');
    const operatorHome = scratch('squire-operator-home-');
    const configRoots: string[] = [];

    for (const agentKind of ['codex', 'claude'] as const) {
      const configRoot = trustySquireConfigRoot(supervisorRoot);
      await connectTrustySquireForPair({
        agentKind,
        operatorHome,
        configRoot,
        run: async (_command, _args, _timeoutMs, env) => {
          configRoots.push(env.XDG_CONFIG_HOME ?? '');
        },
      });
    }

    const expected = resolve(supervisorRoot, 'beeline', 'squire-host-config');
    expect(configRoots).toEqual([expected, expected]);
    expect(
      trustySquireConfigRootForRuntimeConfig(
        resolve(supervisorRoot, 'beeline', 'agents', 'agent-a', 'runtime.json'),
      ),
    ).toBe(expected);
    expect(
      trustySquireConfigRootForRuntimeConfig(
        resolve(supervisorRoot, 'beeline', 'agents', 'agent-b', 'runtime.json'),
      ),
    ).toBe(expected);
  });
});
