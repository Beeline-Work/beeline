// Isolated approval-byte binding proof; no production daemon or grants are used.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestGrant } from '../apps/body/dist/read-only-mcp.js';
import { GrantCommandRunner, GrantRunnerServer } from '../apps/body/dist/grant-runner.js';

const cwd = await mkdtemp(join(tmpdir(), 'beeline-script-hash-proof-'));
const roomId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '11111111-1111-4111-8111-111111111111';
let approved;
const runner = new GrantCommandRunner({
  agentId: 'a'.repeat(64), env: { PATH: `${cwd}:${process.env.PATH}`, HOME: cwd },
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
  const alternate = join(cwd, 'alternate');
  await mkdir(alternate);
  const wrapper = ['env', `PATH=${alternate}:/usr/bin:/bin`, 'chosen'];
  await writeFile(join(cwd, 'chosen'), '#!/bin/sh\nprintf approved\n', { mode: 0o700 });
  await writeFile(join(alternate, 'chosen'), '#!/bin/sh\nprintf approved\n', { mode: 0o700 });
  await symlink('/bin/echo', join(cwd, 'native'));
  await symlink('/bin/echo', join(alternate, 'echo'));
  for (const argv of [wrapper, ['timeout', '5', ...wrapper], ['env', '-C', alternate, './native'], ['env', '-v', './approved'], ['env', '-iv', '--', './approved'], ['env', `--chdir=${alternate}`, './approved'], ['env', '-u', 'PATH', './approved'], ['env', '-i', '-u', 'FOO', '-C', alternate, './approved'], ['env', '--block-signal=PIPE', './approved'], ['env', '--ignore-signal=PIPE', './approved'], ['env', '--default-signal=', './approved'], ['env', '-i', './approved'], ['env', '-S', 'bash', 'approved'], ['env', '--split-string=bash', 'approved'], ['no-shebang'], ['approved'], ['./approved'], ['./no-shebang'], ['bash', 'approved'], ['python3', 'approved.py'], ['bash', 'linked']]) {
    const python = argv[0] === 'python3';
    const bare = argv[0].endsWith('no-shebang');
    const path = argv.includes('./native') ? 'alternate/native' : (argv.includes(`--chdir=${alternate}`) || argv.includes(alternate)) ? 'alternate/approved' : (argv === wrapper || argv.includes('chosen')) ? 'alternate/chosen' : bare ? 'no-shebang' : python ? 'approved.py' : 'approved';
    const original = python ? "print('approved')\n" : `${bare ? '' : '#!/bin/sh\n'}printf approved\n`;
    const replacement = python ? "print('changed')\n" : `${bare ? '' : '#!/bin/sh\n'}printf changed\n`;
    await writeFile(join(cwd, path), original, { mode: 0o700 });
    if (argv[1] === 'linked') await symlink('approved', join(cwd, 'linked'));
    await requestGrant({ kind: 'command', target: argv.join(' '), purpose: 'Prove approved bytes run', reason: 'Isolated proof' }, {
      roomId, scriptRoots: [cwd], scriptEnv: { PATH: `${cwd}:${process.env.PATH}` }, execute: async (_name, input) => {
        assert.ok(input.script?.sha256, 'approval request must carry a hash');
        // Stand-in human decision: approve exactly the card payload.
        approved = { ...input, grantId: 'proof', workspaceId, status: 'approved', requestedBy: 'c'.repeat(64) };
        return { grantId: 'proof', status: 'approved', auto: false };
      },
    });
    const unchanged = await run(argv);
    assert.equal(unchanged.ok, true, unchanged.text);
    assert.equal(JSON.parse(unchanged.text).exitCode, 0, unchanged.text);
    assert.match(JSON.parse(unchanged.text).output, /approved/);
    await writeFile(join(cwd, path), replacement);
    const changed = await run(argv);
    assert.equal(changed.ok, false, changed.text);
    assert.match(changed.text, /changed after it was approved/);
    console.log(`R-SCRIPT-HASH ${argv.join(' ')}: unchanged runs; changed bytes refused with new approval requested`);
  }
  for (const command of [`env -C ${alternate} -C . ./native`, `env -C ${alternate} ./echo`, 'env --debug /bin/echo', 'env -i -u FOO -C /tmp /bin/echo', 'env -iv -- /bin/echo', 'env --list-signal-handling /bin/echo', 'env --block-signal=PIPE /bin/echo', 'env --default-signal /bin/echo', 'env --ignore-signal=PIPE /bin/echo', 'env - /bin/echo', 'env -S /bin/echo', 'env --split-string /bin/echo', 'env -S/bin/echo', 'env --split-string=/bin/echo', 'env -uPATH /bin/echo', 'env --unset PATH /bin/echo', `env --chdir=${cwd} /bin/echo`, `env --chdir ${cwd} /bin/echo`, `env -C${cwd} /bin/echo`, 'env -u PATH /bin/echo', 'env --unset=PATH /bin/echo', `env -C ${cwd} /bin/echo`, 'env -i /bin/echo', 'env -i echo', '/bin/echo', 'echo']) {
  const expected = command === 'env -i -u FOO -C /tmp /bin/echo' ? 'x' : 'approved';
  await requestGrant({ kind: 'command', target: `${command} ${expected}`, purpose: 'Prove native execution', reason: 'Isolated proof' }, {
    roomId, scriptRoots: [cwd], scriptEnv: { PATH: `${cwd}:${process.env.PATH}` }, execute: async (_name, input) => {
      assert.equal(input.script, undefined, 'native executable must retain ordinary grant behavior');
      approved = { ...input, grantId: 'native-proof', workspaceId, status: 'approved', requestedBy: 'c'.repeat(64) };
      return { grantId: 'native-proof', status: 'approved', auto: false };
    },
  });
  const native = await run([...command.split(' '), expected]);
  assert.equal(native.ok, true, native.text);
  assert.equal(JSON.parse(native.text).exitCode, 0, native.text);
  assert.ok(JSON.parse(native.text).output.includes(expected), native.text);
  console.log(`R-SCRIPT-HASH ${command}: ordinary native grant still runs`);
  }
} finally {
  await server.close();
  await rm(cwd, { recursive: true, force: true });
}
