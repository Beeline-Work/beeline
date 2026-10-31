// ARCHIVED-OUTPUT-1: built storage report and host sweep on a throwaway dirty checkout.
import { mkdtemp, mkdir, writeFile, readdir, lstat, utimes, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { rememberStorageOwner, pruneArchivedCheckoutStorage } from '../apps/body/dist/storage-owners.js';
import { helperStorageReport } from '../apps/body/dist/storage-report.js';
const root = await mkdtemp(join(tmpdir(), 'beeline-archived-output-'));
const checkout = join(root, 'beeline/corners/proof');
let child;
const exists = path => access(path).then(() => true, () => false);
async function age(path) {
  if ((await lstat(path)).isDirectory()) for (const name of await readdir(path)) await age(join(path, name));
  await utimes(path, new Date('2000-01-01'), new Date('2000-01-01'));
}
try {
  execFileSync('git', ['init', '-q', checkout]);
  await writeFile(join(checkout, '.gitignore'), 'build/\n.codegraph/\n');
  await writeFile(join(checkout, 'source'), 'unpublished source');
  for (const category of ['build', '.codegraph']) {
    await mkdir(join(checkout, category));
    await writeFile(join(checkout, category, 'output'), 'x'.repeat(8192));
    await age(join(checkout, category));
  }
  await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'proof', kind: 'corners', itemId: 'proof', ended: true, endedAt: Date.now() - 9 * 86400_000 });
  child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: checkout, stdio: 'ignore' });
  await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  const exited = new Promise(done => child.once('exit', done));
  const report = await helperStorageReport(root);
  assert.ok(report.entries.some(entry => entry.path === checkout));
  assert.ok(await exists(join(checkout, 'build')), 'report must be read-only');
  await pruneArchivedCheckoutStorage(root, { inUse: async () => false });
  assert.equal(await exists(join(checkout, 'build')), false);
  assert.equal(await exists(join(checkout, '.codegraph')), false);
  assert.equal(await exists(checkout), false);
  await exited;
  console.log('ARCHIVED-OUTPUT-1 PASS: built report identifies stale output; host sweep stops the child and deletes the entire dirty checkout');
} finally { child?.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
