import { describe, expect, it } from 'vitest';

import { replyMessageText } from './message-reply';

describe('message replies', () => {
  it('encodes an agent reply as an exact canonical tag', () => {
    expect(replyMessageText('  Can you expand on that?  ', 'codex')).toBe(
      '@codex Can you expand on that?',
    );
  });

  it('keeps a human reply untagged', () => {
    expect(replyMessageText('  Thanks  ')).toBe('Thanks');
  });
});
