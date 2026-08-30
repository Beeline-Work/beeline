import { describe, expect, it } from 'vitest';
import { standingAskFromEvents } from './conclude-watch.js';

describe('standingAskFromEvents', () => {
  it('recognizes a model question and a later human answer', () => {
    const ask = {
      id: 'ask',
      pubkey: 'agent',
      created_at: 1,
      content: 'Which branch?',
      tags: [['t', 'agent-message']],
    };
    expect(standingAskFromEvents([ask], 'agent')).toBe(true);
    expect(
      standingAskFromEvents(
        [ask, { ...ask, id: 'answer', pubkey: 'human', created_at: 2, content: 'main' }],
        'agent',
      ),
    ).toBe(false);
  });
});
