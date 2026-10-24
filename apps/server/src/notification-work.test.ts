import { expect, it, vi } from 'vitest';
import { CommanderWakeDeadlines } from './commander-wakes.js';
import { LiveHub } from './live.js';
import type { SqlDatabase } from './database.js';
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


it('coalesces repeated commander notifications and rereads once after an in-flight change', async () => {
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const query = vi.fn(async () => {
    if (++calls === 1) await first;
    return { rows: [{ due: null }], rowCount: 1 };
  });
  const live = new LiveHub();
  const error = vi.fn();
  const deadlines = new CommanderWakeDeadlines({ query } as unknown as SqlDatabase, live, error);
  try {
    for (let n = 0; n < 15; n++) live.publish({
      type: 'invalidate', roomId: 'room', targetAgentId: 'agent', reason: 'postgres:agent_commands',
    });
    expect(query).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(error).not.toHaveBeenCalled();
  } finally { deadlines.stop(); }
});
