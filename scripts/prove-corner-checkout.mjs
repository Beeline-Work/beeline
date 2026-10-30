import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withCornerCheckoutLock } from '../apps/body/dist/corner-checkout-lock.js';
import { syncCornerBranch } from '../apps/body/dist/corner-branch-sync.js';

const root = await mkdtemp(join(process.env.HOME, 'checkout-proof-'));
const checkout = join(root, 'checkout');
const remote = join(root, 'remote.git');
const peer = join(root, 'peer');
const env = { ...process.env, GIT_AUTHOR_NAME:'Proof', GIT_AUTHOR_EMAIL:'proof@example.com',
  GIT_COMMITTER_NAME:'Proof', GIT_COMMITTER_EMAIL:'proof@example.com' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding:'utf8', stdio:['ignore','pipe','pipe'] });
let owner;
try {
  git(root, 'init', '-b', 'feature/proof', checkout);
  await writeFile(join(checkout, 'input.txt'), 'base\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'base');
  git(root, 'clone', '--bare', checkout, remote);
  git(checkout, 'remote', 'add', 'origin', remote);
  git(root, 'clone', remote, peer);
  const source = `import { withCornerCheckoutLock } from ${JSON.stringify(new URL('../apps/body/dist/corner-checkout-lock.js', import.meta.url).href)};
    import { writeFile } from 'node:fs/promises';
    await withCornerCheckoutLock(${JSON.stringify(checkout)}, async () => {
      await writeFile(${JSON.stringify(join(checkout, 'input.txt'))}, 'unfinished build input\\n');
      console.log('editing'); await new Promise(() => {});
    });`;
  owner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio:['ignore','pipe','pipe'] });
  await new Promise((done, reject) => {
    let output = '';
    owner.stdout.on('data', chunk => { output += chunk; if (output.includes('editing')) done(); });
    owner.once('error', reject);
    owner.once('exit', code => { if (!output.includes('editing')) reject(new Error(`owner exited ${code}`)); });
  });
  await assert.rejects(withCornerCheckoutLock(checkout, async () => {
    await writeFile(join(checkout, 'input.txt'), 'clobbered\n');
  }), /in use by another agent/);
  assert.equal(await readFile(join(checkout, 'input.txt'), 'utf8'), 'unfinished build input\n');
  const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
  await writeFile(join(peer, 'input.txt'), 'peer push\n');
  git(peer, 'add', '.'); git(peer, 'commit', '-m', 'peer push'); git(peer, 'push', 'origin', 'feature/proof');
  await withCornerCheckoutLock(checkout, async () => {
    await assert.rejects(syncCornerBranch({ worktreePath:checkout, featureBranch:'feature/proof' }), /uncommitted/);
    assert.equal(await readFile(join(checkout, 'input.txt'), 'utf8'), 'unfinished build input\n');
  });
  console.log('Reproduction checkout-1 PASS: competing writer refused, crash releases ownership, peer sync preserves unfinished build input');
} finally {
  owner?.kill('SIGKILL');
  await rm(root, { recursive:true, force:true });
}
