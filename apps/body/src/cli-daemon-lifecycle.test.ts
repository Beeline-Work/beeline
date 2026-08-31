import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
    const entrypoint = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', entrypoint, 'daemon', '--agent', 'a'.repeat(64)],
        {
          cwd: resolve(entrypoint, '..'),
          env: {
            ...process.env,
            XDG_STATE_HOME: stateHome,
            BEELINE_SYSTEMD_USER: '0',
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
});
