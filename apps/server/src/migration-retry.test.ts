import { describe, expect, it } from 'vitest';
import { isDeadlock, retryOnDeadlock } from './migration-retry.js';

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

describe('retryOnDeadlock', () => {
  it('reruns the idempotent migration after a deadlock', async () => {
    let calls = 0;
    const waits: number[] = [];
    await retryOnDeadlock(
      async () => {
        calls += 1;
        if (calls < 3) throw deadlock();
      },
      { delayMs: () => 5, sleep: async (ms) => void waits.push(ms) },
    );
    expect(calls).toBe(3);
    expect(waits).toEqual([5, 5]);
  });

  it('gives up after the attempt budget', async () => {
    let calls = 0;
    await expect(
      retryOnDeadlock(
        async () => {
          calls += 1;
          throw deadlock();
        },
        { attempts: 2, sleep: async () => undefined },
      ),
    ).rejects.toThrow('deadlock detected');
    expect(calls).toBe(2);
  });

  it('does not retry other failures', async () => {
    let calls = 0;
    await expect(
      retryOnDeadlock(
        async () => {
          calls += 1;
          throw Object.assign(new Error('syntax error'), { code: '42601' });
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow('syntax error');
    expect(calls).toBe(1);
    expect(isDeadlock(deadlock())).toBe(true);
  });
});
