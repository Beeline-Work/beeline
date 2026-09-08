import { describe, expect, it } from 'vitest';

import { replyMessageText } from './message-reply';

describe('message replies', () => {
  it('keeps agent reply text free of a synthesized display-name mention', () => {
    expect(replyMessageText('  Can you expand on that?  ')).toBe('Can you expand on that?');
  });
});
