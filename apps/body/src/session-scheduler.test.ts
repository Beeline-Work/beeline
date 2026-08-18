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

/**
 * Regression suite for the scout's head-of-line probe (`report.md` Appendix A).
 * These four cases previously demonstrated the choke: every activation in the
 * Workspace was serialized behind one mutex that also held the ACP spawn and
 * the >=800ms eviction teardown. They now assert the un-choked contract.
 */
describe('Workspace session scheduler concurrency', () => {
  it('activates another Room while a slow Room activation is still pending', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 4, idleMs: 60_000 });
    const releaseSlowActivate = deferred();
    const events: string[] = [];

    const slow: SessionLifecycle = {
      activate: async () => {
        events.push('a:activate:start');
        await releaseSlowActivate.promise;
        events.push('a:activate:end');
        return 'a-physical';
      },
      suspend: async () => undefined,
    };
    const fast: SessionLifecycle = {
      activate: async () => {
        events.push('b:activate');
        return 'b-physical';
      },
      suspend: async () => undefined,
    };

    const a = scheduler.run('room-a', slow, async () => {
      events.push('a:task');
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    const b = scheduler.run('room-b', fast, async () => {
      events.push('b:task');
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    // room-a is still spawning. Its reservation holds a slot (so capacity is
    // still honest) but it no longer holds the workspace-wide mutex.
    expect(scheduler.snapshot()).toMatchObject({ live: 2, pending: 1 });
    expect(events).toEqual(['a:activate:start', 'b:activate', 'b:task']);

    releaseSlowActivate.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual([
      'a:activate:start',
      'b:activate',
      'b:task',
      'a:activate:end',
      'a:task',
    ]);
    await scheduler.dispose();
  });

  it('pays two evictions concurrently instead of serializing their teardown', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 2, idleMs: 60_000 });
    const SUSPEND_COST_MS = 120;
    const lifecycle = (channel: string): SessionLifecycle => ({
      activate: async () => `${channel}-physical`,
      suspend: async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, SUSPEND_COST_MS));
      },
    });

    await scheduler.run('room-a', lifecycle('room-a'), async () => undefined);
    await scheduler.run('room-b', lifecycle('room-b'), async () => undefined);
    const started = Date.now();
    const c = scheduler.run('room-c', lifecycle('room-c'), async () => undefined);
    const d = scheduler.run('room-d', lifecycle('room-d'), async () => undefined);
    await Promise.all([c, d]);
    // Two evictions used to cost >= 2x the teardown because both ran under the
    // one capacity mutex. They now overlap.
    expect(Date.now() - started).toBeLessThan(SUSPEND_COST_MS * 2);
    await scheduler.dispose();
  });

  it('never oversubscribes while several Rooms reserve and activate concurrently', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 3, idleMs: 60_000 });
    const active = new Set<string>();
    let maxActive = 0;
    const lifecycle = (channel: string): SessionLifecycle => ({
      activate: async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        active.add(channel);
        maxActive = Math.max(maxActive, active.size);
        return `${channel}-physical`;
      },
      suspend: async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        active.delete(channel);
      },
    });

    const rooms = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
    await Promise.all(
      rooms.map((room) =>
        scheduler.run(room, lifecycle(room), async () => {
          await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        }),
      ),
    );

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(scheduler.snapshot().live).toBeLessThanOrEqual(3);
    await scheduler.dispose();
  });

  it('budgets capacity per Room so a busy Room cannot starve a quiet one', async () => {
    const scheduler = new SessionScheduler({
      perRoomLiveSessions: 2,
      workspaceFloor: 8,
      idleMs: 60_000,
    });
    const active = new Set<string>();
    const lifecycle = (channel: string): SessionLifecycle => ({
      activate: async () => {
        active.add(channel);
        return `${channel}-physical`;
      },
      suspend: async () => {
        active.delete(channel);
      },
    });
    const holds = new Map<string, ReturnType<typeof deferred>>();
    const hold = (channel: string, roomKey: string) => {
      const gate = deferred();
      holds.set(channel, gate);
      return scheduler.run(channel, lifecycle(channel), async () => gate.promise, { roomKey });
    };

    // Room A saturates its own budget with two long-running corners.
    const a1 = hold('room-a:corner-1', 'room-a');
    const a2 = hold('room-a:corner-2', 'room-a');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    // A third Room-A corner must wait for Room A's own budget, not the Workspace.
    const a3 = hold('room-a:corner-3', 'room-a');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(scheduler.generations('room-a:corner-3')).toHaveLength(0);

    // Room B is untouched by Room A's saturation.
    let roomBRan = false;
    const b = scheduler.run(
      'room-b',
      lifecycle('room-b'),
      async () => {
        roomBRan = true;
      },
      { roomKey: 'room-b' },
    );
    await b;
    expect(roomBRan).toBe(true);
    expect(active.has('room-b')).toBe(true);

    for (const gate of holds.values()) gate.resolve();
    await Promise.all([a1, a2, a3]);
    expect(scheduler.generations('room-a:corner-3')).toHaveLength(1);
    await scheduler.dispose();
  });

  it('grows the Workspace ceiling with the number of Rooms the supervisor serves', async () => {
    let rooms = 1;
    const scheduler = new SessionScheduler({
      perRoomLiveSessions: 2,
      workspaceFloor: 4,
      activeRoomCount: () => rooms,
      idleMs: 60_000,
    });
    expect(scheduler.snapshot().maxLive).toBe(4);
    rooms = 5;
    expect(scheduler.snapshot().maxLive).toBe(10);
    await scheduler.dispose();
  });
});
