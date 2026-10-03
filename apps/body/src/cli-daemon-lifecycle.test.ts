import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HELPER_EXIT_CODES } from './helper-lifecycle.js';
import { NO_AGENTS_EXIT_STATUS } from './systemd.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Run the CLI as a service manager would, with a recording `systemctl` on PATH. */
async function daemon(args: string[], env: NodeJS.ProcessEnv = {}) {
  const stateHome = await mkdtemp(resolve(tmpdir(), 'beeline-daemon-cli-'));
  roots.push(stateHome);
  const bin = resolve(stateHome, 'bin');
  const log = resolve(stateHome, 'systemctl.jsonl');
  await mkdir(bin);
  const systemctl = resolve(bin, 'systemctl');
  await writeFile(
    systemctl,
    `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
  );
  await chmod(systemctl, 0o755);
  const entrypoint = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entrypoint, 'daemon', ...args], {
      cwd: resolve(entrypoint, '..'),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        XDG_STATE_HOME: stateHome,
        BEELINE_LIB_DIR: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output += chunk));
    child.stderr.on('data', (chunk: string) => (output += chunk));
    child.once('error', reject);
    child.once('exit', (code) => resolveResult({ code, output }));
  });
  const calls = (await readFile(log, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { ...result, calls };
}

describe('daemon entry points', () => {
  it('keeps a per-agent unit that cannot hand off to the machine helper, retiring nothing', async () => {
    // An old `beeline-agent@<key>` unit starts the new bundle. Here the helper
    // cannot be installed (not the canonical launcher), so nothing may be
    // stopped: the unit exits restartable and tries again.
    const result = await daemon(['--agent', 'a'.repeat(64)], {
      BEELINE_SYSTEMD_USER: '1',
      BEELINE_LAUNCHD_USER: '1',
    });
    expect(result.code).toBe(HELPER_EXIT_CODES.failed);
    expect(result.output).toContain('machine helper did not start');
    expect(result.calls.some((args) => ['disable', 'stop'].includes(args[1]!))).toBe(false);
  }, 20_000);

  it('ends the machine helper with the not-restarted status when nothing is paired', async () => {
    const result = await daemon(['--machine'], { BEELINE_SYSTEMD_USER: '0', BEELINE_LAUNCHD_USER: '0' });
    expect(result.code).toBe(NO_AGENTS_EXIT_STATUS);
    expect(result.output).toContain('no paired agent on this machine');
  }, 20_000);

  it('refuses a daemon start that names neither the machine nor one runtime', async () => {
    const result = await daemon([], { BEELINE_SYSTEMD_USER: '0', BEELINE_LAUNCHD_USER: '0' });
    expect(result.code).toBe(HELPER_EXIT_CODES.failed);
    expect(result.output).toContain('daemon requires --machine');
  }, 20_000);
});
