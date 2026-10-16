import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

for (const outdated of [false, true])
  test(`cold boot ${outdated ? 'refreshes a refused helper' : 'starts the baked helper without download'}`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-entrypoint-'));
    let child;
    try {
      await mkdir(resolve(root, '.local/bin'), { recursive: true });
      const launcher = resolve(root, '.local/bin/beeline');
      const waitingHelper = '#!/bin/sh\necho ready\nexec sleep 60\n';
      await writeFile(
        launcher,
        outdated ? '#!/bin/sh\necho required-newer-helper\nexit 1\n' : waitingHelper,
        { mode: 0o755 },
      );
      const replacement = resolve(root, 'replacement');
      await writeFile(replacement, waitingHelper, { mode: 0o755 });
      const installer = resolve(root, 'install.sh');
      await writeFile(
        installer,
        '#!/bin/sh\necho download\ncp "$HOME/replacement" "$HOME/.local/bin/beeline"\n',
      );
      const source = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
      const script = resolve(root, 'entrypoint.sh');
      await writeFile(script, source.replaceAll('/opt/beeline/install.sh', installer));
      child = spawn('/bin/sh', [script], {
        env: { ...process.env, HOME: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error('helper did not start')), 10_000);
        child.on('error', reject);
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes('ready')) {
            clearTimeout(timer);
            accept();
          }
        });
      });
      assert.equal(output.includes('download'), outdated);
      if (outdated) assert.ok(output.indexOf('required-newer-helper') < output.indexOf('download'));
    } finally {
      if (child) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await rm(root, { recursive: true, force: true });
    }
  });
