import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readDaemonReleaseFleetStatus,
  writeDaemonReleaseStatus,
} from './release-status.js';

const AGENT = 'a'.repeat(64);
const SHA = '1'.repeat(40);

describe('daemon release status', () => {
  it('writes one release-version + sha record and reports it only for the matching live pid', async () => {
    const stateHome = await mkdtemp(resolve(tmpdir(), 'beeline-release-status-'));
    const runtimeDir = resolve(stateHome, 'beeline', 'agents', AGENT);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(resolve(runtimeDir, 'runtime.json'), '{}');
    await writeFile(resolve(runtimeDir, 'daemon.pid'), '4242\n');

    await writeDaemonReleaseStatus(
      runtimeDir,
      AGENT,
      { version: 'v0.0.1', commit: SHA },
      { pid: 4242, now: () => new Date('2026-08-31T12:00:00.000Z') },
    );

    await expect(readDaemonReleaseFleetStatus({ XDG_STATE_HOME: stateHome })).resolves.toEqual([
      {
        agentPubkey: AGENT,
        state: 'ready',
        releaseVersion: 'v0.0.1',
        sourceSha: SHA,
        pid: 4242,
        readyAt: '2026-08-31T12:00:00.000Z',
      },
    ]);
    await writeFile(resolve(runtimeDir, 'daemon.pid'), '9999\n');
    expect((await readDaemonReleaseFleetStatus({ XDG_STATE_HOME: stateHome }))[0]?.state).toBe(
      'stale',
    );
  });

  it('does not let development or malformed identities overwrite a production status', async () => {
    const stateHome = await mkdtemp(resolve(tmpdir(), 'beeline-release-status-invalid-'));
    const runtimeDir = resolve(stateHome, 'beeline', 'agents', AGENT);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(resolve(runtimeDir, 'runtime.json'), '{}');
    await writeFile(resolve(runtimeDir, 'daemon.pid'), '4242\n');
    await writeDaemonReleaseStatus(runtimeDir, AGENT, { version: 'v0.0.1', commit: SHA }, { pid: 4242 });
    const before = await readFile(resolve(runtimeDir, 'release-status.json'), 'utf8');

    await expect(
      writeDaemonReleaseStatus(runtimeDir, AGENT, { version: 'development', commit: 'HEAD' }),
    ).resolves.toBeUndefined();
    expect(await readFile(resolve(runtimeDir, 'release-status.json'), 'utf8')).toBe(before);
  });
});
