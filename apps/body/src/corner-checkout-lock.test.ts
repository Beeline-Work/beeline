import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withCornerCheckoutLock } from './corner-checkout-lock.js';

it('checkout-1: waits on a symlink alias and recovers ownership after a crashed turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'corner-checkout-owner-'));
  const alias = `${root}-alias`;
  await symlink(root, alias);
  const source = `import { withCornerCheckoutLock } from ${JSON.stringify(new URL('./corner-checkout-lock.ts', import.meta.url).pathname)};
    await withCornerCheckoutLock(${JSON.stringify(root)}, async () => { console.log('owned'); await new Promise(() => {}); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((done, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('owned')) done(); });
      child.once('error', reject);
      child.once('exit', code => { if (!output.includes('owned')) reject(new Error(`owner exited ${code}`)); });
    });
    let entered = false;
    const waiting = withCornerCheckoutLock(alias, async () => { entered = true; return 'recovered'; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(entered).toBe(false);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await expect(waiting).resolves.toBe('recovered');
    await expect(withCornerCheckoutLock(root, async () => { throw new Error('turn failed'); }))
      .rejects.toThrow('turn failed');
    await expect(withCornerCheckoutLock(root, async () => 'released')).resolves.toBe('released');
  } finally {
    child.kill('SIGKILL');
    await rm(alias, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
