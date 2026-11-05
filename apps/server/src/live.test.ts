import { EventEmitter } from 'node:events';
import { afterEach, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { describe } from 'vitest';
import { expect, it } from 'vitest';
import { LiveHub, type LiveEvent } from './live.js';


describe("live.presence-dedupe", () => {
  describe('LiveHub presence version dedupe', () => {
    it('bounds stored Room presence and drops an archived Room', () => {
      const live = new LiveHub();
      for (let index = 0; index <= LiveHub.MAX_PRESENCE_ENTRIES; index++)
        live.publish({ type: 'presence', roomId: `room-${index}`, agentId: 'agent',
          status: 'online', observedAt: index + 1 });
      expect(live.presenceSnapshot('room-0')).toEqual([]);
      expect(live.presenceSnapshot('room-1')).toHaveLength(1);
      live.publish({ type: 'invalidate', roomId: 'room-1', reason: 'corner', archived: true });
      expect(live.presenceSnapshot('room-1')).toEqual([]);
    });
  
    it('keeps recent offline human presence but expires and caps old entries', () => {
      const live = new LiveHub();
      live.humanConnected('expired', 0);
      live.humanDisconnected('expired', 0);
      live.humanConnected('current', 2 * 60 * 60_000);
      expect(live.humanPresence('expired')).toBeUndefined();
      for (let index = 0; index <= LiveHub.MAX_OFFLINE_HUMANS; index++) {
        const id = `human-${index}`;
        live.humanConnected(id, 2 * 60 * 60_000);
        live.humanDisconnected(id, 2 * 60 * 60_000);
      }
      expect(live.humanPresence('human-0')).toBeUndefined();
      expect(live.humanPresence('human-1')).toBeDefined();
      expect(live.humanPresence('current')?.status).toBe('online');
    });
  
    it('drops an equal online presence version so listener+writer fanout is one emit', () => {
      const live = new LiveHub();
      const received: LiveEvent[] = [];
      live.subscribe('room-a', (event) => received.push(event));
  
      live.publish({
        type: 'presence',
        roomId: 'room-a',
        agentId: 'agent',
        status: 'online',
        observedAt: 10,
      });
      live.publish({
        type: 'presence',
        roomId: 'room-a',
        agentId: 'agent',
        status: 'online',
        observedAt: 10,
      });
  
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ type: 'presence', observedAt: 10, status: 'online' });
    });
  
    it('still emits when observedAt advances', () => {
      const live = new LiveHub();
      const received: LiveEvent[] = [];
      live.subscribe('room-a', (event) => received.push(event));
  
      live.publish({
        type: 'presence',
        roomId: 'room-a',
        agentId: 'agent',
        status: 'online',
        observedAt: 10,
      });
      live.publish({
        type: 'presence',
        roomId: 'room-a',
        agentId: 'agent',
        status: 'online',
        observedAt: 11,
      });
  
      expect(received).toHaveLength(2);
    });
  });
});

describe("postgres-live-recovery", () => {
  class Client extends EventEmitter implements LivePgClient {
    connect = vi.fn(async () => {});
    query = vi.fn(async (_sql: string) => {});
    end = vi.fn(async () => { this.emit('end'); });
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const listeners: PostgresLiveListener[] = [];
  afterEach(async () => { for (const listener of listeners.splice(0)) await listener.stop(); vi.useRealTimers(); });
  function fixture(clients: Client[]) {
    let recover!: () => void;
    const unsubscribe = vi.fn();
    const database = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      onRecovery: (callback: () => void) => { recover = callback; return unsubscribe; } } as unknown as SqlDatabase;
    const live = new LiveHub();
    const factory = vi.fn(() => { const next = clients.shift(); if (!next) throw new Error('unexpected connection'); return next; });
    const listener = new PostgresLiveListener(database, live, factory);
    listeners.push(listener);
    void listener.run();
    return { listener, factory, live, recover: () => recover(), unsubscribe };
  }
  
  describe('LISTEN admission', () => {
    it('parks an initial failure for an idle day and admits one actual database recovery', async () => {
      vi.useFakeTimers();
      const first = new Client(), second = new Client();
      first.connect.mockRejectedValueOnce(new Error('connection refused'));
      const { listener, factory, recover, unsubscribe } = fixture([first, second]);
      await settle();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(factory).toHaveBeenCalledOnce();
      expect(listener.projectionHealth().connected).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      recover(); await settle();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(listener.projectionHealth().connected).toBe(true);
      await listener.stop();
      expect(unsubscribe).toHaveBeenCalledOnce();
      recover(); await settle();
      expect(factory).toHaveBeenCalledTimes(2);
    });
  
    it('coalesces error/end into one replacement and does not replenish it merely by opening', async () => {
      vi.useFakeTimers();
      const first = new Client(), second = new Client(), third = new Client();
      const { listener, factory, recover } = fixture([first, second, third]);
      await settle();
      first.emit('error', new Error('link lost')); first.emit('end');
      await settle();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(listener.projectionHealth().connected).toBe(true);
      second.emit('end'); await settle();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      recover(); await settle();
      expect(factory).toHaveBeenCalledTimes(3);
      expect(listener.projectionHealth().connected).toBe(true);
    });
  
    it('accepts real committed traffic as recovery and ignores notifications from the retired socket', async () => {
      const first = new Client(), second = new Client(), third = new Client();
      const { factory, listener } = fixture([first, second, third]);
      await settle(); first.emit('end'); await settle();
      const wake = vi.fn(); listener.setPushWake(wake);
      first.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({ table: 'push_devices', operation: 'INSERT', roomId: '' }) });
      expect(wake).not.toHaveBeenCalled();
      second.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({ table: 'push_devices', operation: 'INSERT', roomId: '' }) });
      await settle(); expect(wake).toHaveBeenCalledOnce();
      second.emit('end'); await settle();
      expect(factory).toHaveBeenCalledTimes(3);
    });
  
    it('rejects late LISTEN completion after a disconnect during acquisition', async () => {
      vi.useFakeTimers();
      const first = new Client(), second = new Client(); let finish!: () => void;
      first.query.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
      const { listener, factory, recover } = fixture([first, second]);
      await settle(); first.emit('end'); finish(); await settle();
      expect(first.query).toHaveBeenCalledOnce();
      expect(listener.projectionHealth().connected).toBe(false);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(factory).toHaveBeenCalledOnce();
      recover(); await settle();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(listener.projectionHealth().connected).toBe(true);
    });
  
    it('drains stop during an opening connection without publishing ready or starting another one', async () => {
      const client = new Client(); let open!: () => void;
      client.connect.mockImplementation(() => new Promise<void>(resolve => { open = resolve; }));
      const { listener, factory } = fixture([client]);
      const stopped = listener.stop(); open(); await stopped;
      expect(listener.projectionHealth().connected).toBe(false);
      expect(client.query).not.toHaveBeenCalled();
      expect(factory).toHaveBeenCalledOnce();
    });
  });
});
