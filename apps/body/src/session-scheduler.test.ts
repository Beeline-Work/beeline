import { describe, expect, it } from 'vitest';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Workspace session scheduler', () => {
  it('caps live ACP processes, evicts only idle owners, and preserves one pin per channel', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 2, idleMs: 60_000 });
    const active = new Set<string>();
    const maxObserved: number[] = [];
    const generations = new Map<string, number>();
    const lifecycle = (channel: string): SessionLifecycle => ({
      activate: async () => {
        active.add(channel);
        maxObserved.push(active.size);
        const generation = (generations.get(channel) ?? 0) + 1;
        generations.set(channel, generation);
        return `${channel}-physical-${generation}`;
      },
      suspend: async () => {
        active.delete(channel);
      },
    });

    await scheduler.run('room-a', lifecycle('room-a'), async () => undefined);
    await scheduler.run('room-b', lifecycle('room-b'), async () => undefined);
    await scheduler.run('room-c', lifecycle('room-c'), async () => undefined);

    expect(Math.max(...maxObserved)).toBe(2);
    expect(scheduler.snapshot().live).toBe(2);
    expect(scheduler.generations('room-c')).toEqual(['room-c-physical-1']);
    await scheduler.dispose();
  });

  it('serializes one channel losslessly while different channels use available capacity', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 2, idleMs: 60_000 });
    const first = deferred();
    const order: string[] = [];
    const noOp: SessionLifecycle = {
      activate: async () => crypto.randomUUID(),
      suspend: async () => undefined,
    };

    const a1 = scheduler.run('corner-a', noOp, async () => {
      order.push('a1-start');
      await first.promise;
      order.push('a1-end');
    });
    const a2 = scheduler.run('corner-a', noOp, async () => order.push('a2'));
    const b = scheduler.run('corner-b', noOp, async () => order.push('b'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(order).toEqual(['a1-start', 'b']);
    first.resolve();
    await Promise.all([a1, a2, b]);
    expect(order).toEqual(['a1-start', 'b', 'a1-end', 'a2']);
    expect(scheduler.generations('corner-a')).toHaveLength(1);
    await scheduler.dispose();
  });

  it('does not oversubscribe when different channels activate concurrently at capacity one', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 1, idleMs: 60_000 });
    const releaseFirst = deferred();
    const active = new Set<string>();
    let maxActive = 0;
    const lifecycle = (channel: string): SessionLifecycle => ({
      activate: async () => {
        active.add(channel);
        maxActive = Math.max(maxActive, active.size);
        return `${channel}-physical`;
      },
      suspend: async () => {
        active.delete(channel);
      },
    });

    const first = scheduler.run('corner-a', lifecycle('corner-a'), async () => {
      await releaseFirst.promise;
    });
    const second = scheduler.run('corner-b', lifecycle('corner-b'), async () => undefined);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(scheduler.generations('corner-b')).toHaveLength(0);
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
    expect(scheduler.generations('corner-b')).toEqual(['corner-b-physical']);
    await scheduler.dispose();
  });

  it('keeps a Room responsive while later corner work waits for background capacity', async () => {
    const scheduler = new SessionScheduler({
      maxLiveSessions: 1,
      idleMs: 60_000,
      reserveInteractiveSlot: true,
    });
    const releaseFirstCorner = deferred();
    const firstCornerStarted = deferred();
    const releaseRoom = deferred();
    const roomStarted = deferred();
    const active = new Set<string>();
    let maxActive = 0;
    const lifecycle = (channel: string): SessionLifecycle => ({
      activate: async () => {
        active.add(channel);
        maxActive = Math.max(maxActive, active.size);
        return `${channel}-physical`;
      },
      suspend: async () => {
        active.delete(channel);
      },
    });

    const firstCorner = scheduler.run(
      'corner-a',
      lifecycle('corner-a'),
      async () => {
        firstCornerStarted.resolve();
        await releaseFirstCorner.promise;
      },
      { priority: 'background' },
    );
    await firstCornerStarted.promise;
    const nextCorner = scheduler.run(
      'corner-b',
      lifecycle('corner-b'),
      async () => undefined,
      { priority: 'background' },
    );

    expect(scheduler.generations('corner-b')).toHaveLength(0);

    const room = scheduler.run(
      'room',
      lifecycle('room'),
      async () => {
        roomStarted.resolve();
        await releaseRoom.promise;
      },
      { priority: 'interactive' },
    );
    await roomStarted.promise;

    expect(scheduler.generations('room')).toEqual(['room-physical']);
    expect(scheduler.snapshot()).toMatchObject({ live: 2, maxLive: 2 });
    expect(maxActive).toBe(2);

    releaseRoom.resolve();
    await room;
    releaseFirstCorner.resolve();
    await Promise.all([firstCorner, nextCorner]);
    expect(scheduler.generations('corner-b')).toEqual(['corner-b-physical']);
    expect(maxActive).toBe(2);
    await scheduler.dispose();
  });
});
