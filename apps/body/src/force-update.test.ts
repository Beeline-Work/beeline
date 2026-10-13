import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ReleaseTransaction } from './managed-update.js';
import { journalInterruptedTurns } from './force-update-journal.js';
import { writeUpdateState } from './self-update.js';
it('a server minimum durably interrupts every active agent through the one release transaction', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-minimum-'));
  const layout = { libDir: resolve(root, 'lib/beeline'), releasesRoot: resolve(root, 'lib/beeline-releases'), binDir: resolve(root, 'bin') };
  const agents = [resolve(root, 'one'), resolve(root, 'two')];
  for (const dir of agents) await mkdir(dir);
  await mkdir(resolve(layout.releasesRoot, 'new/lib/beeline'), { recursive: true });
  await writeFile(resolve(layout.releasesRoot, 'new/lib/beeline/bundle.json'), JSON.stringify({ version: 'v2.0.0' }));
  await writeUpdateState(layout, { stagedReleaseId: 'new' });
  const handoff = vi.fn(async () => undefined);
  const transaction = new ReleaseTransaction({ layout, loadedRelease: 'old', env: {}, idle: () => false,
    interrupt: () => { for (const dir of agents) journalInterruptedTurns(dir, [{ roomId: 'room', requestId: dir, generationId: 'old' }]); },
    prepare: async () => undefined, changed: () => undefined, handoff, failed: (error) => { throw error; },
  });
  try {
    transaction.notify(undefined, 'v2.0.0', true);
    // Journals precede any asynchronous preparation or shutdown.
    for (const dir of agents) expect(await readFile(resolve(dir, 'force-update-interruptions.json'), 'utf8')).toContain('old');
    await transaction.pending;
    await transaction.idleChanged();
    expect(handoff).toHaveBeenCalledWith('new', true);
  } finally { transaction.dispose(); await rm(root, { recursive: true, force: true }); }
});
