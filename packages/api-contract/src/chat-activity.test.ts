import { describe, expect, it } from 'vitest';
import { chatActivityAt } from './chat-activity.js';

const room = { id: 'room', name: 'Room', updatedAt: 10 };

describe('chatActivityAt', () => {
  it('is the latest message, falling back to the Room update', () => {
    expect(chatActivityAt({ room })).toBe(10);
    expect(chatActivityAt({ room, latestMessage: { createdAt: 50 } as never })).toBe(50);
  });

  it('counts a waiting corner handing back later than the last message', () => {
    expect(
      chatActivityAt({
        room,
        latestMessage: { createdAt: 50 } as never,
        openCorners: [
          { id: 'a', name: 'A', state: 'waiting', mine: true, waitingSince: 90 },
          { id: 'b', name: 'B', state: 'waiting', mine: true, waitingSince: 20 },
        ],
      }),
    ).toBe(90);
  });
});
