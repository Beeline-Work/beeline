import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from './acp.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  'harness-node-missing-path: starts an env-node ACP harness (npm symlink: %s, wrapped: %s)',
  async (linked, wrapped) => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-harness-path-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const dist = join(root, 'lib');
    const empty = join(root, 'empty-path');
    await Promise.all([bin, dist, empty].map((dir) => mkdir(dir)));
    await symlink(process.execPath, join(bin, 'node'));
    const target = join(linked ? dist : bin, 'harness');
    await writeFile(
      target,
      `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method === 'initialize' ? {protocolVersion:1} : {sessionId:'started'}})+'\\n');
});

`,
    );
    await chmod(target, 0o755);
    const command = join(bin, 'harness');
    if (linked) await symlink(target, command);
    // This host has /usr/bin/node, so an empty search directory is the closest
    // stand-in for a launchd PATH without the user's Node installation.
    const client = new AcpClient({
      agentCommand: wrapped ? '/bin/sh' : command,
      ...(wrapped
        ? { harnessCommand: command, agentArgs: ['-c', 'exec "$1"', 'proof', command] }
        : {}),
      agentEnv: { PATH: empty },
      resourceScope: 'none',
    });
    try {
      await client.start(3000);
      expect(await client.sessionNew({ cwd: root })).toMatchObject({ sessionId: 'started' });
    } finally {
      await client.stop();
    }
  },
);

it.each(['/usr/bin/env beeline-proof-missing-interpreter', '/beeline-proof-missing-interpreter'])(
  'harness-node-missing-path: diagnoses a missing shebang %s',
  async (interpreter) => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-harness-missing-'));
    roots.push(root);
    const command = join(root, 'harness');
    await writeFile(command, `#!${interpreter}\n`, { mode: 0o755 });
    const client = new AcpClient({
      agentCommand: command,
      agentEnv: { PATH: '/usr/bin:/bin' },
      resourceScope: 'none',
    });
    try {
      const error = await client.start(3000).then(
        () => undefined,
        (error) => error,
      );
      expect(error).toBeInstanceOf(Error);
      const receipt = distillTurnFailureReason(error);
      expect(receipt.text).toContain("it couldn't start:");
      expect(receipt.text).toContain('`beeline connect`');
    } finally {
      await client.stop();
    }
  },
);
