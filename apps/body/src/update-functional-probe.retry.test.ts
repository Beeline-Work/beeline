import { describe, expect, it } from 'vitest';
import {
  retryWhileAdapterReinstalls,
  UpdateFunctionalProbeError,
} from './update-functional-probe.js';

const missing = () =>
  new UpdateFunctionalProbeError(
    'session-start-failed',
    'ACP agent /usr/bin/codex-acp exited code=1 signal=null: bwrap: execvp /usr/bin/codex-acp: No such file or directory',
  );

describe('retryWhileAdapterReinstalls', () => {
  it('waits out a concurrent adapter reinstall instead of failing the probe', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await retryWhileAdapterReinstalls(
      async () => {
        calls += 1;
        if (calls < 3) throw missing();
        return 'served';
      },
      { delayMs: 10, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe('served');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 10]);
  });

  it('gives up after the attempt budget when the binary never comes back', async () => {
    let calls = 0;
    await expect(
      retryWhileAdapterReinstalls(
        async () => {
          calls += 1;
          throw missing();
        },
        { attempts: 3, sleep: async () => undefined },
      ),
    ).rejects.toThrow(/No such file or directory/);
    expect(calls).toBe(3);
  });

  it('does not retry any other probe failure', async () => {
    let calls = 0;
    await expect(
      retryWhileAdapterReinstalls(
        async () => {
          calls += 1;
          throw new UpdateFunctionalProbeError('turn-failed', 'provider refused');
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow(/turn-failed/);
    expect(calls).toBe(1);
  });
});
