import { describe, expect, it } from 'vitest';
import { newIdentity } from '@beeline/gate';
import { buildLifecycleMessage } from './lifecycle-publisher.js';

describe('daemon lifecycle publication boundary', () => {
  it('refuses JSON documents as daemon-authored kind:9 content', () => {
    expect(() =>
      buildLifecycleMessage({
        kind: 'rearmed-failure',
        channelId: 'room',
        owner: newIdentity('agent'),
        content: JSON.stringify({ status: 'paused', reason: 'machine-state' }),
      }),
    ).toThrow('refused JSON content in daemon-authored kind:9 publication');
  });

  it('continues to build approved plain lifecycle facts', () => {
    const event = buildLifecycleMessage({
      kind: 'turn-receipt',
      channelId: 'room',
      owner: newIdentity('agent'),
      content: 'Agent reply complete.',
      tags: [['status', 'complete']],
    });

    expect(event.kind).toBe(9);
    expect(event.content).toBe('Agent reply complete.');
  });
});
