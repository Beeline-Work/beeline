import { expect, it, vi } from 'vitest';
import { NotificationWork } from './notification-work.js';

it('bounds notification work, preserves every delivery and releases capacity after failure', async () => {
  const queue = new NotificationWork(2);
  let active = 0, peak = 0;
  const delivered: number[] = [];
  const settled = await Promise.allSettled(Array.from({ length: 15 }, (_, n) => queue.run(async () => {
    peak = Math.max(peak, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      delivered.push(n);
      if (n === 0) throw new Error('provider failed');
    } finally { active--; }
  })));
  expect(peak).toBe(2);
  expect(delivered).toEqual(Array.from({ length: 15 }, (_, n) => n));
  expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
  await expect(queue.run(async () => 'next delivery')).resolves.toBe('next delivery');
});


it('keeps an acquired delivery exclusive until its idempotent release', async () => {
  const queue = new NotificationWork(1);
  const first = await queue.acquire();
  const started: string[] = [];
  const second = queue.run(async () => { started.push('second'); });
  await Promise.resolve();
  expect(started).toEqual([]);
  first();
  first();
  await second;
  const third = await queue.acquire();
  const fourth = queue.run(async () => { started.push('fourth'); });
  await Promise.resolve();
  expect(started).toEqual(['second']);
  third();
  await fourth;
  expect(started).toEqual(['second', 'fourth']);
});
