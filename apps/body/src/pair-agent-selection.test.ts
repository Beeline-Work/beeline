import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';

import { selectPairAgentCommand } from './pair-agent-selection.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function executables(...names: string[]): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'beeline-pair-agent-'));
  cleanup.push(directory);
  await Promise.all(
    names.map(async (name) => {
      const path = resolve(directory, name);
      await writeFile(path, '#!/bin/sh\nexit 0\n');
      await chmod(path, 0o755);
    }),
  );
  return directory;
}

function capture(): { output: Pick<NodeJS.WritableStream, 'write'>; text: () => string } {
  let value = '';
  return {
    output: {
      write(chunk: Uint8Array | string): boolean {
        value += chunk.toString();
        return true;
      },
    },
    text: () => value,
  };
}

describe('pair agent auto-selection', () => {
  it('fails clearly when no real ACP-capable agent is installed', async () => {
    await expect(selectPairAgentCommand({ env: { PATH: '' }, interactive: false })).rejects.toThrow(
      /No supported ACP-capable coding agent.*codex.*claude.*goose.*pi.*--agent reference.*LLM key.*--agent custom/s,
    );
  });

  it('auto-selects and announces the sole detected agent', async () => {
    const directory = await executables('codex', 'codex-acp');
    const log = capture();

    const selected = await selectPairAgentCommand({
      env: { PATH: directory },
      interactive: false,
      output: log.output,
    });

    expect(selected).toMatchObject({ kind: 'codex', command: resolve(directory, 'codex-acp') });
    expect(log.text()).toBe('[buzz] using codex (auto-detected)\n');
  });

  it('shows a numbered TTY menu and persists the selected detected command', async () => {
    const codex = await executables('codex', 'codex-acp');
    const goose = await executables('goose');
    const log = capture();

    const selected = await selectPairAgentCommand({
      env: { PATH: [codex, goose].join(delimiter) },
      interactive: true,
      output: log.output,
      ask: async () => '2',
    });

    expect(selected).toEqual({ kind: 'goose', command: resolve(goose, 'goose'), args: ['acp'] });
    expect(log.text()).toContain(
      "Which agent should back this repo's agent?\n  1) codex\n  2) goose\n",
    );
    expect(log.text()).toContain('[buzz] using goose (selected)');
  });

  it('refuses to guess among several detected agents without a TTY', async () => {
    const codex = await executables('codex', 'codex-acp');
    const goose = await executables('goose');

    await expect(
      selectPairAgentCommand({
        env: { PATH: [codex, goose].join(delimiter) },
        interactive: false,
      }),
    ).rejects.toThrow(/codex, goose.*non-interactive.*--agent <name>/);
  });

  it('lets an explicit preset bypass detection and prompting', async () => {
    const reference = await executables('buzz-agent');
    let asked = false;

    const selected = await selectPairAgentCommand({
      explicitKind: 'reference',
      env: { PATH: reference },
      interactive: true,
      ask: async () => {
        asked = true;
        return '1';
      },
    });

    expect(selected.kind).toBe('reference');
    expect(asked).toBe(false);
  });

  it('keeps an explicit custom ACP command working without detection', async () => {
    const directory = await executables('my-acp');

    await expect(
      selectPairAgentCommand({
        explicitKind: 'custom',
        customCommand: 'my-acp serve --stdio',
        env: { PATH: directory },
        interactive: false,
      }),
    ).resolves.toEqual({
      kind: 'custom',
      command: resolve(directory, 'my-acp'),
      args: ['serve', '--stdio'],
    });
  });
});
