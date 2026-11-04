import {describe,expect,it} from 'vitest';
import {chatWatchFiltersKey} from './chat-list-delta';

describe('chatWatchFiltersKey', () => {
  it('ignores Room order but not Room membership', () => {
    const key = chatWatchFiltersKey([{ kinds: [9, 9000], '#h': ['room-a', 'room-b'] }]);
    expect(chatWatchFiltersKey([{ '#h': ['room-b', 'room-a'], kinds: [9000, 9] }])).toBe(key);
    expect(chatWatchFiltersKey([{ kinds: [9, 9000], '#h': ['room-a', 'room-c'] }])).not.toBe(key);
  });
});
