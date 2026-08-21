import { describe, expect, it } from 'vitest';
import { serializeRepoLanding } from './land-queue.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('per-repository landing queue', () => {
  it('serializes same-repo corners in arrival order and releases after teardown', async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = serializeRepoLanding('Owner/Repo', async () => {
      order.push('first-start');
      await gate.promise;
      order.push('first-end');
    });
    const second = serializeRepoLanding('owner/repo', async () => order.push('second'));
    const other = serializeRepoLanding('owner/other', async () => order.push('other'));

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start', 'other']);
    gate.resolve();
    await Promise.all([first, second, other]);
    expect(order).toEqual(['first-start', 'other', 'first-end', 'second']);

    await serializeRepoLanding('owner/repo', async () => order.push('after-teardown'));
    expect(order.at(-1)).toBe('after-teardown');
  });
});
