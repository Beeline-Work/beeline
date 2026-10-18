import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AcpClient } from '../apps/body/dist/acp.js';

// Run this script with a stripped PATH and an installed nvm ACP command as
// argv[2]. It never starts a machine helper or contacts the Beeline server.
const command = process.argv[2];
assert(command?.startsWith('/'), 'Supply an absolute installed ACP harness path');
assert.equal(process.env.PATH, '/usr/bin:/bin');
const root = await mkdtemp(join(tmpdir(), 'beeline-node-path-proof-'));
const state = join(root, 'state');
await mkdir(state);
const client = new AcpClient({
  agentCommand: command,
  agentEnv: { HOME: root, XDG_CONFIG_HOME: state, XDG_STATE_HOME: state, PATH: process.env.PATH },
  resourceScope: 'none',
});
try {
  await client.start(15000);
  const interpreter = await readlink(`/proc/${client.child.pid}/exe`);
  assert.equal(interpreter, await realpath(join(dirname(command), 'node')));
  console.log(
    'Reproduction harness-node-missing-path: installed ACP initialized with stripped daemon PATH',
  );
  console.log(`Interpreter: ${interpreter}`);
} finally {
  await client.stop();
  await rm(root, { recursive: true, force: true });
}
