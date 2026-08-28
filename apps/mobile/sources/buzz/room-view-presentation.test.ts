import { describe, expect, it } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import {
  displayRoomMessage,
  mergeDisplayPages,
  type ChatDisplayMessage,
} from './room-view-presentation';

describe('Room view presentation', () => {
  it('keeps a model-unavailable server row visible as a system notice', () => {
    const message: RoomViewMessage = {
      id: 'model-unavailable',
      text: 'Model unavailable · openrouter-ox/z-ai/glm-5.3-flash',
      createdAt: 12,
      author: {
        pubkey: 'b'.repeat(64),
        kind: 'agent',
        name: 'Pi agent',
      },
      presentation: 'system',
    };

    expect(displayRoomMessage(message, 'a'.repeat(64))).toMatchObject({
      id: 'model-unavailable',
      text: 'Model unavailable · openrouter-ox/z-ai/glm-5.3-flash',
      isSystemNotice: true,
      isAgentAuthor: true,
    });
  });

  it('orders response, paged history, signed outbox, and live-overlay partitions by time', () => {
    const message = (id: string, timestamp: number): ChatDisplayMessage => ({
      id,
      text: id,
      isUser: id === 'stale-outbox',
      timestamp,
    });

    expect(
      mergeDisplayPages(
        [message('older-page', 10)],
        [message('server-tail', 40)],
        [message('stale-outbox', 20)],
        [message('live-overlay', 30)],
      ).map((item) => item.id),
    ).toEqual(['older-page', 'stale-outbox', 'live-overlay', 'server-tail']);
  });
});
