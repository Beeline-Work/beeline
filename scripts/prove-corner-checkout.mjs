import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeCornerWorktree } from '../apps/body/dist/room-runtime.js';
import { syncCornerBranch } from '../apps/body/dist/corner-branch-sync.js';

// Real Git and a hung tool process; no helper lifecycle or operator Workspace.
const root = await mkdtemp(join(tmpdir(), 'checkout-proof-'));
const seed = join(root, 'seed');
const remote = join(root, 'remote.git');
const env = { ...process.env, GIT_AUTHOR_NAME: 'Proof', GIT_AUTHOR_EMAIL: 'proof@example.com',
  GIT_COMMITTER_NAME: 'Proof', GIT_COMMITTER_EMAIL: 'proof@example.com' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let owner;
try {
  git(root, 'init', '-b', 'main', seed);
  await writeFile(join(seed, 'input.txt'), 'base\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'base');
  git(root, 'clone', '--bare', seed, remote);
  const input = { supervisorRoot: root, cornerId: 'corner', remote: `file://${remote}`,
    targetBranch: 'main', featureBranch: 'feature/proof', token: 'fixture' };
  const [a, b] = await Promise.all(['a', 'b'].map(id => materializeCornerWorktree({ ...input,
    committer: { name: id, publicKey: id.repeat(64) } })));
  assert.notEqual(a.gitCommonDir, b.gitCommonDir);
  const source = `import { writeFile } from 'node:fs/promises';
    await writeFile(${JSON.stringify(join(a.path, 'input.txt'))}, 'unfinished build input\\n');
    console.log('editing'); setInterval(() => {}, 1000);`;
  owner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((done, reject) => {
    let output = '';
    owner.stdout.on('data', chunk => { output += chunk; if (output.includes('editing')) done(); });
    owner.once('error', reject);
    owner.once('exit', code => { if (!output.includes('editing')) reject(new Error(`owner exited ${code}`)); });
  });
  await writeFile(join(b.path, 'input.txt'), 'peer push\n');
  git(b.path, 'add', '.'); git(b.path, 'commit', '-m', 'peer push'); git(b.path, 'push', 'origin', 'feature/proof');
  assert.equal(owner.exitCode, null);
  assert.equal(await readFile(join(a.path, 'input.txt'), 'utf8'), 'unfinished build input\n');
  await assert.rejects(syncCornerBranch({ worktreePath: a.path, featureBranch: 'feature/proof' }), /uncommitted/);
  assert.equal(await readFile(join(a.path, 'input.txt'), 'utf8'), 'unfinished build input\n');
  console.log('checkout-1 PASS: concurrent private refs/files; peer commits and pushes while another agent tool hangs; unfinished work preserved');
} finally {
  if (owner && owner.exitCode === null) { const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited; }
  await rm(root, { recursive: true, force: true });
}
