import { describe, expect, it } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import { advanceRoomHistoryCursor, retainRoomHistoryCursor } from './room-history-pagination';

const message = (id: string, createdAt: number): RoomViewMessage => ({
  id,
  createdAt,
  text: id,
  presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
});

describe('Room history pagination cursor', () => {
  it('starts from the bounded conversation tail, never the separate corner tool payload', () => {
    const messages = [message('2'.repeat(64), 20), message('3'.repeat(64), 30)];
    const state = retainRoomHistoryCursor(null, 'corner', messages);

    expect(state?.before).toEqual({ createdAt: 20, id: '2'.repeat(64) });
  });

  it('does not move the history walk when live updates replace the Room tail', () => {
    const initial = retainRoomHistoryCursor(null, 'corner', [message('2'.repeat(64), 20)]);
    const afterLiveInsert = retainRoomHistoryCursor(initial, 'corner', [
      message('3'.repeat(64), 30),
      message('4'.repeat(64), 40),
    ]);

    expect(afterLiveInsert).toBe(initial);
  });

  it('advances only to the server cursor and stops when the bounded page has no successor', () => {
    expect(
      advanceRoomHistoryCursor('corner', {
        nextBefore: { createdAt: 10, id: '1'.repeat(64) },
      }),
    ).toEqual({ roomId: 'corner', before: { createdAt: 10, id: '1'.repeat(64) } });
    expect(advanceRoomHistoryCursor('corner', {})).toEqual({ roomId: 'corner', before: null });
  });
});
