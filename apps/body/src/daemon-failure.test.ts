import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { clearDaemonStartFailures, daemonFailurePath, recordDaemonStartFailure } from './daemon-failure.js';
it('records arbitrary repeated failures without acquiring authority to stop service', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-diagnostic-'));
  try {
    for (let n = 0; n < 10; n++) await recordDaemonStartFailure(root, new Error(`failure ${n}`), n);
    const diagnostic = JSON.parse(await readFile(daemonFailurePath(root), 'utf8'));
    expect(diagnostic.failures).toHaveLength(10);
    expect(diagnostic).not.toHaveProperty('distressedAt');
    await clearDaemonStartFailures(root);
    expect(JSON.parse(await readFile(daemonFailurePath(root), 'utf8'))).toMatchObject({ failures: [], lastError: 'failure 9', recoveredAt: expect.any(Number) });
  } finally { await rm(root, { recursive: true, force: true }); }
});
