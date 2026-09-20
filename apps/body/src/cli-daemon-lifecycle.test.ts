import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { UNKNOWN_AGENT_EXIT_STATUS } from './systemd.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('daemon lifecycle exits', () => {
  it('makes an orphan systemd instance stop after one clear unknown-agent failure', async () => {
    const stateHome = await mkdtemp(resolve(tmpdir(), 'beeline-unknown-agent-'));
    roots.push(stateHome);
    const bin = resolve(stateHome, 'bin');
    await mkdir(bin);
    const systemctl = resolve(bin, 'systemctl');
    await writeFile(systemctl, '#!/bin/sh\nexit 0\n');
    await chmod(systemctl, 0o755);
    const entrypoint = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', entrypoint, 'daemon', '--agent', 'a'.repeat(64)],
        {
          cwd: resolve(entrypoint, '..'),
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            XDG_STATE_HOME: stateHome,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let output = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code) => resolveResult({ code, output }));
    });
    expect(result.code).toBe(UNKNOWN_AGENT_EXIT_STATUS);
    expect(result.output).toContain('unknown agent');
    expect(result.output).toContain('refusing systemd restart loop');
  }, 15_000);

  it('reconciles enabled orphan units without touching an enabled live-runtime unit', async () => {
    const stateHome = await mkdtemp(resolve(tmpdir(), 'beeline-orphan-reconcile-'));
    roots.push(stateHome);
    const orphan = 'b'.repeat(64);
    const live = 'c'.repeat(64);
    const liveRuntime = resolve(stateHome, 'beeline', 'agents', live, 'runtime.json');
    await mkdir(resolve(liveRuntime, '..'), { recursive: true });
    await writeFile(liveRuntime, '{}\n');

    const bin = resolve(stateHome, 'bin');
    const log = resolve(stateHome, 'systemctl.jsonl');
    await mkdir(bin);
    const systemctl = resolve(bin, 'systemctl');
    await writeFile(
      systemctl,
      `#!/usr/bin/env node\n` +
        `import { appendFileSync } from 'node:fs';\n` +
        `const args = process.argv.slice(2);\n` +
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\n` +
        `if (args[1] === 'list-unit-files') process.stdout.write(${JSON.stringify(
          `beeline-agent@${orphan}.service enabled\nbeeline-agent@${live}.service enabled\n`,
        )});\n`,
    );
    await chmod(systemctl, 0o755);

    const entrypoint = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', entrypoint, 'daemon', '--agent', orphan],
        {
          cwd: resolve(entrypoint, '..'),
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            XDG_STATE_HOME: stateHome,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let output = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code) => resolveResult({ code, output }));
    });

    expect(result.code).toBe(UNKNOWN_AGENT_EXIT_STATUS);
    expect(result.output).toContain('unknown agent');
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toEqual([
      [
        '--user',
        'list-unit-files',
        'beeline-agent@*.service',
        '--state=enabled',
        '--no-legend',
        '--no-pager',
      ],
      ['--user', 'disable', `beeline-agent@${orphan}.service`],
      ['--user', 'reset-failed', `beeline-agent@${orphan}.service`],
    ]);
  }, 15_000);
});
