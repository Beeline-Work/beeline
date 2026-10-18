import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_DETECT_AGENT_KINDS,
  installedAgentProgramEnvironment,
  missingAgentProgramMessage,
  explainAgentProgramFailure,
} from './agent-command.js';
import { collectConnectWizard, CONNECT_HARNESSES, type ConnectPrompts } from './connect-command.js';
import { loadBodyConfig } from './config.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'beeline-installed-program-'));
  roots.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  return { root, bin, env: { HOME: root, PATH: bin, BEELINE_HARNESS_PATH_AUGMENT: '0' } };
}
describe('installed agent programs', () => {
  it.each(AUTO_DETECT_AGENT_KINDS)(
    'stops the wizard before probing a missing %s program',
    async (kind) => {
      const { env } = await fixture();
      const loadModels = vi.fn();
      const prompts = {
        select: async (input: { options: { value: string }[] }) => {
          expect(input.options.map((option) => option.value)).toEqual([...CONNECT_HARNESSES]);
          return kind;
        },
      } as unknown as ConnectPrompts;
      await expect(
        collectConnectWizard(
          prompts,
          loadModels,
          { read: async () => undefined, save: async () => {} },
          env,
          async () => undefined,
          { detect: () => [] },
        ),
      ).rejects.toThrow(missingAgentProgramMessage(kind));
      expect(loadModels).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['claude', 'claude', 'CLAUDE_CODE_EXECUTABLE'],
    ['codex', 'codex', 'CODEX_PATH'],
    ['pi', 'pi', 'PI_ACP_PI_COMMAND'],
  ] as const)('sets the %s adapter launch to the user program', async (kind, binary, variable) => {
    const { bin, env, root } = await fixture();
    const program = join(bin, binary);
    await writeFile(program, '#!/bin/sh\necho 2.0.0\n');
    await chmod(program, 0o755);
    const overrides = installedAgentProgramEnvironment(kind, env);
    expect(overrides).toEqual({ [variable]: program });
    const config = loadBodyConfig({
      workspaceRoot: root,
      agent: { kind, command: join(bin, `${kind}-acp`), args: [] },
      env: { ...env, BUZZ_DEV_MCP_BIN: '/bin/true', BEELINE_READONLY_MCP_BIN: '/bin/true' },
    });
    expect(config.agentEnv[variable]).toBe(program);
  });
  it('names the installed Claude version and remedy when an old CLI rejects adapter flags', async () => {
    const { bin, env } = await fixture();
    const program = join(bin, 'claude');
    await writeFile(program, '#!/bin/sh\necho 1.0.0\n');
    await chmod(program, 0o755);
    const error = await explainAgentProgramFailure(new Error('unknown option --settings'), {
      ...env,
      CLAUDE_CODE_EXECUTABLE: program,
    });
    expect(String(error)).toContain('Claude Code 1.0.0 could not start');
    expect(String(error)).toContain('curl -fsSL https://claude.ai/install.sh | bash');
  });
});
