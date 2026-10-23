import { describe, expect, it, vi } from 'vitest';
import { TransitionWork } from './transition-work';

describe('Room transition storage work', () => {
  function fixture() {
    let scheduled: (() => void) | undefined;
    const queue = new TransitionWork((work) => {
      scheduled = work;
      return () => { scheduled = undefined; };
    });
    return { queue, completeInteractions: () => { const work = scheduled; scheduled = undefined; work?.(); } };
  }
  it('waits for both native transitions and JS interactions and coalesces a Room burst', async () => {
    const { queue, completeInteractions } = fixture();
    const firstEnd = queue.begin();
    const secondEnd = queue.begin();
    const old = vi.fn(async () => {});
    const latest = vi.fn(async () => {});
    const writes = [queue.enqueue('room', old), queue.enqueue('room', latest)];
    completeInteractions();
    expect(latest).not.toHaveBeenCalled();
    firstEnd();
    completeInteractions();
    expect(latest).not.toHaveBeenCalled();
    secondEnd();
    expect(latest).not.toHaveBeenCalled();
    completeInteractions();
    await Promise.all(writes);
    expect(old).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
  it('flushes on background even if a native transition never finishes', async () => {
    const { queue, completeInteractions } = fixture();
    const end = queue.begin();
    const write = vi.fn(async () => {});
    const done = queue.enqueue('room', write);
    queue.flush();
    await done;
    end();
    completeInteractions();
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('cancels scheduled work when navigation begins before it can run', async () => {
    const { queue, completeInteractions } = fixture();
    const write = vi.fn(async () => {});
    const done = queue.enqueue('room', write);
    const end = queue.begin();
    completeInteractions();
    expect(write).not.toHaveBeenCalled();
    end();
    completeInteractions();
    await done;
    expect(write).toHaveBeenCalledTimes(1);
  });
});
