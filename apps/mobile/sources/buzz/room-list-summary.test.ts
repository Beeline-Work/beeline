import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '@/sync/transport';
import { latestRoomMessage } from './room-list-summary';

function message(content: string, createdAt: number, tags: string[][] = []): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room-1',
    payload: { id: `event-${createdAt}`, content, createdAt, tags },
  };
}

describe('Room list summary', () => {
  it('returns the newest conversational message', () => {
    expect(latestRoomMessage([message('first', 1), message('latest room note', 3)])).toBe(
      'latest room note',
    );
  });

  it('ignores Corner control records and agent activity', () => {
    const activity: SessionEvent = {
      type: 'assistant_delta',
      sessionId: 'room-1',
      text: 'running tests',
      seq: 4,
    };
    expect(
      latestRoomMessage([
        message('keep me', 1),
        message('Agent opened #fix-tests', 2, [['subchannel', 'corner-1']]),
        message('control', 3, [['t', 'body-control']]),
        activity,
      ]),
    ).toBe('keep me');
  });
});
