// Isolated approval-byte binding proof; no production daemon or grants are used.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestGrant } from '../apps/body/dist/read-only-mcp.js';
import { GrantCommandRunner, GrantRunnerServer } from '../apps/body/dist/grant-runner.js';

const cwd = await mkdtemp(join(tmpdir(), 'beeline-script-hash-proof-'));
const roomId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '11111111-1111-4111-8111-111111111111';
let approved;
const runner = new GrantCommandRunner({
  agentId: 'a'.repeat(64), env: { PATH: process.env.PATH, HOME: cwd },
  api: { execute: async (name) => name === 'listTurnAgentGrants' ? { grants: [approved] } : {} },
});
runner.register(roomId, { workspaceId, cwd, writePolicy: () => ({ surface: 'corner' }),
  turn: () => ({ requestId: 'proof', generationId: 'proof' }) });
const server = new GrantRunnerServer(runner);
try {
  const endpoint = await server.start();
  const run = async (argv) => {
    const response = await fetch(`${endpoint.url}/run`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, argv }),
    });
    return { ok: response.ok, text: await response.text() };
  };
  for (const argv of [['./approved'], ['./no-shebang'], ['bash', 'approved'], ['python3', 'approved.py'], ['bash', 'linked']]) {
    const python = argv[0] === 'python3';
    const bare = argv[0] === './no-shebang';
    const path = bare ? 'no-shebang' : python ? 'approved.py' : 'approved';
    const original = python ? "print('approved')\n" : `${bare ? '' : '#!/bin/sh\n'}printf approved\n`;
    const replacement = python ? "print('changed')\n" : `${bare ? '' : '#!/bin/sh\n'}printf changed\n`;
    await writeFile(join(cwd, path), original, { mode: 0o700 });
    if (argv[1] === 'linked') await symlink('approved', join(cwd, 'linked'));
    await requestGrant({ kind: 'command', target: argv.join(' '), purpose: 'Prove approved bytes run', reason: 'Isolated proof' }, {
      roomId, scriptRoots: [cwd], execute: async (_name, input) => {
        assert.ok(input.script?.sha256, 'approval request must carry a hash');
        // Stand-in human decision: approve exactly the card payload.
        approved = { ...input, grantId: 'proof', workspaceId, status: 'approved', requestedBy: 'c'.repeat(64) };
        return { grantId: 'proof', status: 'approved', auto: false };
      },
    });
    const unchanged = await run(argv);
    assert.equal(unchanged.ok, true, unchanged.text);
    assert.match(unchanged.text, /approved/);
    await writeFile(join(cwd, path), replacement);
    const changed = await run(argv);
    assert.equal(changed.ok, false, changed.text);
    assert.match(changed.text, /changed after it was approved/);
    console.log(`R-SCRIPT-HASH ${argv.join(' ')}: unchanged runs; changed bytes refused with new approval requested`);
  }
  await requestGrant({ kind: 'command', target: '/bin/echo approved', purpose: 'Prove native execution', reason: 'Isolated proof' }, {
    roomId, scriptRoots: [cwd], execute: async (_name, input) => {
      assert.equal(input.script, undefined, 'native executable must retain ordinary grant behavior');
      approved = { ...input, grantId: 'native-proof', workspaceId, status: 'approved', requestedBy: 'c'.repeat(64) };
      return { grantId: 'native-proof', status: 'approved', auto: false };
    },
  });
  const native = await run(['/bin/echo', 'approved']);
  assert.equal(native.ok, true, native.text);
  assert.match(native.text, /approved/);
  console.log('R-SCRIPT-HASH native executable: ordinary grant still runs');
} finally {
  await server.close();
  await rm(cwd, { recursive: true, force: true });
}
