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
    const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
    const result = await connectTrustySquireForPair({
      agentKind: 'codex',
      operatorHome,
      run: async (command, args, timeoutMs) => calls.push({ command, args, timeoutMs }),
    });

    expect(calls).toEqual([
      {
        command: 'npx',
        args: ['-y', '@trusty-squire/mcp', 'connect', '--target=codex', '--no-interactive'],
        timeoutMs: 30 * 60_000,
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
});
