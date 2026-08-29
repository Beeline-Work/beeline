import { describe, expect, it } from 'vitest';
import { roomDeckState } from './room-deck-state';

describe('roomDeckState', () => {
  it('is idle when nothing is unread and the server reports no agent activity', () => {
    expect(roomDeckState({ unread: false })).toBe('idle');
  });

  it('inherits working from the server rollup when a room turn or corner is live', () => {
    expect(roomDeckState({ unread: false, agentState: 'working' })).toBe('working');
  });

  it('inherits needs-you from a corner waiting on a human, even with no unread message', () => {
    expect(roomDeckState({ unread: false, agentState: 'needs-you' })).toBe('needs-you');
  });

  it('golds on an unread message alone, with no agent activity at all', () => {
    expect(roomDeckState({ unread: true })).toBe('needs-you');
  });

  it('never demotes needs-you to working: needs-you always wins the precedence', () => {
    expect(roomDeckState({ unread: true, agentState: 'working' })).toBe('needs-you');
    expect(roomDeckState({ unread: false, agentState: 'needs-you' })).toBe('needs-you');
  });
});
