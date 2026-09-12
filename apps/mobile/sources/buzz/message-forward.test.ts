import { describe, expect, it, vi } from 'vitest';
import {
  formatForwardedMessage,
  forwardedMessageParts,
  forwardMessageToRoom,
} from './message-forward';

describe('message forwarding', () => {
  it('quotes every source line and separates the Room caption', () => {
    const text = formatForwardedMessage('first\nsecond', 'general');
    expect(text).toBe('> first\n> second\n\nFORWARDED FROM #general');
    expect(forwardedMessageParts(text)).toEqual({
      body: '> first\n> second',
      caption: 'FORWARDED FROM #general',
    });
  });

  it('posts the quoted source into the chosen Room', async () => {
    const send = vi.fn(async () => undefined);
    await forwardMessageToRoom(send, 'room-two', 'ship it', 'general');
    expect(send).toHaveBeenCalledWith({
      roomId: 'room-two',
      text: '> ship it\n\nFORWARDED FROM #general',
    });
  });
});
