import { describe, expect, it } from 'vitest';

import { prefixAgentReply, replyExcerpt } from './chat-reply';

describe('chat replies', () => {
  it('addresses the original Agent at the beginning of a reply', () => {
    expect(prefixAgentReply('please expand on that', 'lina')).toBe('@lina please expand on that');
  });

  it('does not duplicate an Agent mention already at the beginning', () => {
    expect(prefixAgentReply('@Lina, please expand on that', 'lina')).toBe(
      '@Lina, please expand on that',
    );
  });

  it('normalizes and truncates quoted reply context', () => {
    expect(replyExcerpt('  one\n\n two   three  ', 12)).toBe('one two thr…');
  });
});
