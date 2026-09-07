import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { ConnectionPresence } from './connection-presence.js';
import { LiveHub } from './live.js';

afterEach(() => vi.useRealTimers());

describe('connection-owned presence', () => {
  it('does not let a late same-second online refresh overwrite offline', () => {
    const live = new LiveHub();
    live.publish({ type: 'presence', roomId: 'room', agentId: 'agent', status: 'offline', observedAt: 7 });
    live.publish({ type: 'presence', roomId: 'room', agentId: 'agent', status: 'online', observedAt: 7 });
    expect(live.latestAgentPresence('agent', 'room')?.status).toBe('offline');
  });

  it('marks a dropped socket offline and refreshes without heartbeat writes', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const database = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: sql.includes('UPDATE live_outputs') ? 1 : 0 };
      }),
    } as unknown as SqlDatabase;
    const events: string[] = [];
    const live = new LiveHub();
    live.subscribe('room', (event) => {
      if (event.type === 'presence') events.push(event.status);
    });
    const presence = new ConnectionPresence(database, live, 30_000, 5_000);

    const release = presence.connect('room', 'agent', { releaseVersion: 'v1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((sql) => /INSERT INTO live_outputs|UPDATE live_outputs/.test(sql))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(calls.filter((sql) => /INSERT INTO live_outputs|UPDATE live_outputs/.test(sql))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('pg_notify'))).toHaveLength(3);

    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((sql) => /INSERT INTO live_outputs|UPDATE live_outputs/.test(sql))).toHaveLength(2);
    expect(events.at(-1)).toBe('offline');
    await presence.stop();
  });

  it('debounces reconnects so a rolling connection handoff does not flap', async () => {
    vi.useFakeTimers();
    const database = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as unknown as SqlDatabase;
    const presence = new ConnectionPresence(database, new LiveHub(), 30_000, 5_000);
    const first = presence.connect('room', 'agent');
    await vi.advanceTimersByTimeAsync(0);
    first();
    await vi.advanceTimersByTimeAsync(4_000);
    const second = presence.connect('room', 'agent');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(database.query).toHaveBeenCalledTimes(1);
    second();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(database.query).toHaveBeenCalledTimes(2);
    await presence.stop();
  });
});
