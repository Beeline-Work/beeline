import { describe, expect, it } from 'vitest';
import { CHAT_BOTTOM_FOLLOW_THRESHOLD, isNearChatBottom } from './chat-scroll';

describe('room chat bottom following', () => {
  it('follows content that fits without scrolling', () => {
    expect(
      isNearChatBottom({ contentHeight: 500, viewportHeight: 600, offsetY: 0 }),
    ).toBe(true);
  });

  it('follows when the reader is within the bottom threshold', () => {
    expect(
      isNearChatBottom({
        contentHeight: 1_500,
        viewportHeight: 500,
        offsetY: 1_000 - CHAT_BOTTOM_FOLLOW_THRESHOLD,
      }),
    ).toBe(true);
  });

  it('does not interrupt a reader who deliberately scrolled into history', () => {
    expect(
      isNearChatBottom({
        contentHeight: 1_500,
        viewportHeight: 500,
        offsetY: 1_000 - CHAT_BOTTOM_FOLLOW_THRESHOLD - 1,
      }),
    ).toBe(false);
  });
});
