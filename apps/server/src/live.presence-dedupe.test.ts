import { describe, expect, it } from 'vitest';
import { LiveHub, type LiveEvent } from './live.js';

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
