import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ReleaseTransaction, UPDATE_DRAIN_DEADLINE_MS, versionAtLeast } from './managed-update.js';
import { writeUpdateState } from './self-update.js';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(overrides: Partial<ConstructorParameters<typeof ReleaseTransaction>[0]> = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-release-')); roots.push(root);
  const layout = { libDir: resolve(root, 'lib/beeline'), releasesRoot: resolve(root, 'lib/beeline-releases'), binDir: resolve(root, 'bin') };
  const handoff = vi.fn(async () => undefined), failed = vi.fn(), interrupt = vi.fn();
  const transaction = new ReleaseTransaction({ layout, loadedRelease: 'old', env: {}, idle: () => false, interrupt, handoff, changed: () => undefined, failed, ...overrides });
  return { transaction, handoff, failed, interrupt, layout };
}
it('uses one idle event or fixed five-minute deadline, and hands off exactly once', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.transaction.prepared('new');
  await vi.advanceTimersByTimeAsync(UPDATE_DRAIN_DEADLINE_MS - 1);
  expect(f.handoff).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.handoff).toHaveBeenCalledTimes(1);
  expect(f.handoff).toHaveBeenCalledWith('new', true);
  await f.transaction.idleChanged();
  expect(f.handoff).toHaveBeenCalledTimes(1);
  f.transaction.dispose();
});
it('newer prepared content replaces the pending target without renewing the drain allowance', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.transaction.prepared('first');
  await vi.advanceTimersByTimeAsync(200_000);
  await f.transaction.prepared('newer');
  await vi.advanceTimersByTimeAsync(100_000);
  expect(f.handoff).toHaveBeenCalledTimes(1);
  expect(f.handoff).toHaveBeenCalledWith('newer', true);
  f.transaction.dispose();
});
it('idle handoff is immediate and a failed journal never grants a fresh drain budget', async () => {
  vi.useFakeTimers();
  const handoff = vi.fn().mockRejectedValueOnce(new Error('journal unavailable')).mockResolvedValue(undefined);
  const f = await fixture({ handoff });
  await f.transaction.prepared('new');
  await vi.advanceTimersByTimeAsync(UPDATE_DRAIN_DEADLINE_MS);
  expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'journal unavailable' }), undefined);
  await f.transaction.idleChanged();
  expect(handoff).toHaveBeenNthCalledWith(2, 'new', true);
  f.transaction.dispose();
});
it('coalesces a newer notice during preparation before accepting any handoff', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((done) => { finish = done; });
  let prepares = 0;
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ idle: () => true, prepare: async () => {
    prepares++;
    if (prepares === 1) await pending;
    await writeUpdateState(f.layout, { stagedReleaseId: prepares === 1 ? 'first' : 'newer' });
  } });
  f.transaction.notify('first');
  await Promise.resolve();
  f.transaction.notify('newer');
  finish();
  await f.transaction.pending;
  await f.transaction.idleChanged();
  expect(prepares).toBe(2);
  expect(f.handoff).toHaveBeenCalledTimes(1);
  expect(f.handoff).toHaveBeenCalledWith('newer', false);
  f.transaction.dispose();
});
it('a forced minimum joins the same transaction, interrupts immediately and refuses below-minimum content', async () => {
  const f = await fixture({ env: { BEELINE_UPDATE_DISABLE: '1' }, prepare: async () => undefined });
  await mkdir(resolve(f.layout.releasesRoot, 'new/lib/beeline'), { recursive: true });
  await writeFile(resolve(f.layout.releasesRoot, 'new/lib/beeline/bundle.json'), JSON.stringify({ version: 'v1.0.0' }));
  await writeUpdateState(f.layout, { stagedReleaseId: 'new' });
  f.transaction.notify(undefined, 'v2.0.0', true);
  await f.transaction.pending;
  expect(f.interrupt).toHaveBeenCalledOnce();
  expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('below required v2.0.0') }), 'v2.0.0');
  expect(f.handoff).not.toHaveBeenCalled();
  f.transaction.dispose();
});
it('version comparison supports the published vocabulary', () => {
  expect(versionAtLeast('v0.0.9', 'v0.0.10')).toBe(false);
  expect(versionAtLeast('v1.0.0', 'v1.0.0')).toBe(true);
});

it('a fresh current target cancels an obsolete prepared release', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.transaction.prepared('obsolete');
  await f.transaction.prepared('old');
  await vi.advanceTimersByTimeAsync(UPDATE_DRAIN_DEADLINE_MS);
  expect(f.transaction.desiredRelease).toBeUndefined();
  expect(f.handoff).not.toHaveBeenCalled();
  f.transaction.dispose();
});
