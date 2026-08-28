import { describe, expect, it } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import { displayRoomMessage } from './room-view-presentation';

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
});
