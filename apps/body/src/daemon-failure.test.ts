import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_FAILURE_WINDOW_MS,
  clearDaemonStartFailures,
  daemonFailurePath,
  recordDaemonStartFailure,
  settleDaemonStartFailure,
} from './daemon-failure.js';
import { DaemonApiError } from './daemon-api-client.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('daemon start distress record', () => {
  it('never stops a helper for network failures or a 401, only for faults a restart cannot fix', async () => {
    const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-daemon-distress-'));
    roots.push(runtimeDir);
    const network = (code: string) =>
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
    for (const [index, error] of [
      network('ECONNREFUSED'),
      network('UND_ERR_CONNECT_TIMEOUT'),
      network('EAI_AGAIN'),
      new DaemonApiError('monolith daemon request failed (503: unavailable)', 503, true),
      new DaemonApiError('monolith daemon request failed (401: unauthorized)', 401, false),
    ].entries()) {
      await expect(settleDaemonStartFailure(runtimeDir, error, 1_000 + index)).resolves.toEqual({
        distressed: false,
      });
    }
    await expect(readFile(daemonFailurePath(runtimeDir), 'utf8')).rejects.toThrow();

    const config = () => new Error('legacy relay runtime is unsupported; reconnect this agent from the app');
    expect((await settleDaemonStartFailure(runtimeDir, config(), 2_000)).distressed).toBe(false);
    expect((await settleDaemonStartFailure(runtimeDir, config(), 3_000)).distressed).toBe(false);
    await expect(settleDaemonStartFailure(runtimeDir, config(), 4_000)).resolves.toMatchObject({
      distressed: true,
      count: 3,
    });
  });

  it('stops resurrection after three consecutive start failures and retains an operator-visible record', async () => {
    const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-daemon-distress-'));
    roots.push(runtimeDir);
    expect((await recordDaemonStartFailure(runtimeDir, new Error('first'), 1_000)).distressed).toBe(false);
    expect((await recordDaemonStartFailure(runtimeDir, new Error('second'), 2_000)).distressed).toBe(false);
    const last = await recordDaemonStartFailure(runtimeDir, new Error('third'), 3_000);
    expect(last).toMatchObject({ distressed: true, count: 3, path: daemonFailurePath(runtimeDir) });
    expect(JSON.parse(await readFile(last.path, 'utf8'))).toMatchObject({
      failures: [1_000, 2_000, 3_000],
      lastError: 'third',
      distressedAt: 3_000,
    });
  });

  it('forgets a prior healthy start and failures outside the bounded window', async () => {
    const runtimeDir = await mkdtemp(resolve(tmpdir(), 'beeline-daemon-distress-'));
    roots.push(runtimeDir);
    await recordDaemonStartFailure(runtimeDir, 'old', 1_000);
    const afterWindow = await recordDaemonStartFailure(
      runtimeDir,
      'new',
      1_000 + DAEMON_FAILURE_WINDOW_MS + 1,
    );
    expect(afterWindow).toMatchObject({ distressed: false, count: 1 });
    await clearDaemonStartFailures(runtimeDir);
    await expect(readFile(daemonFailurePath(runtimeDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
