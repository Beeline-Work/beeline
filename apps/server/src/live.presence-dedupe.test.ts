import { describe, expect, it } from 'vitest';
import { LiveHub, type LiveEvent } from './live.js';

describe('LiveHub presence version dedupe', () => {
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
