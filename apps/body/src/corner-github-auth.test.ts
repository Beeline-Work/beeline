import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { installCornerGitHubWrappers } from './corner-github-auth.js';

const execFileAsync = promisify(execFile);

describe('corner GitHub wrappers', () => {
  it('mints lazily and retries an authentication failure exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-auth-'));
    const calls = join(root, 'calls');
    const cli = join(root, 'cli.mjs');
    const command = join(root, 'git.mjs');
    await writeFile(
      cli,
      `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(calls)}, 'token\\n'); console.log('fresh-token');`,
    );
    await writeFile(
      command,
      `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';
const path=${JSON.stringify(calls)}; const prior=readFileSync(path,'utf8'); appendFileSync(path, process.env.GH_TOKEN+'\\n');
if (!prior.includes('fresh-token')) { console.error('HTTP 401'); process.exit(1); }
console.log('ok');`,
    );
    await Promise.all([chmod(cli, 0o700), chmod(command, 0o700)]);
    const env = await installCornerGitHubWrappers({
      root,
      runtimeConfigPath: '/runtime.json',
      roomId: 'room',
      cliEntrypoint: cli,
      gitBinary: command,
      ghBinary: command,
      inheritedPath: process.env.PATH,
    });

    expect(await readFile(calls, 'utf8').catch(() => '')).toBe('');
    const result = await execFileAsync(join(env.PATH!.split(':')[0]!, 'git'), ['fetch']);
    expect(result.stdout).toBe('ok\n');
    expect((await execFileAsync(join(env.PATH!.split(':')[0]!, 'gh'), ['pr', 'list'])).stdout).toBe(
      'ok\n',
    );
    const lines = (await readFile(calls, 'utf8')).trim().split('\n');
    expect(lines.filter((line) => line === 'token')).toHaveLength(3);
    expect(lines.filter((line) => line === 'fresh-token')).toHaveLength(3);
  });
});
