import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoomViewHttpError } from '@beeline/buzz-client';
import type { RoomHistoryOutline } from '@beeline/api-contract/phone';

import type { ChatDisplayMessage } from './room-view-presentation';
import { useTranscriptScrubber } from './use-transcript-scrubber';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

const row = (id: string, timestamp: number): ChatDisplayMessage => ({
  id: id.repeat(64),
  text: `message-${id}`,
  isUser: false,
  timestamp,
});

describe('transcript scrubber outline', () => {
  it('keeps the bar on the loaded rows when the outline read is rate-limited', async () => {
    const outline = vi.fn(
      async (): Promise<RoomHistoryOutline> => {
        throw new RoomViewHttpError(429, 'too_many_requests');
      },
    );
    // Stable props, as the Room screen passes them.
    const roomClient = { outline };
    const durableMessages = [row('1', 10), row('2', 20), row('3', 30)];
    let scrubber!: ReturnType<typeof useTranscriptScrubber>;
    function Probe() {
      scrubber = useTranscriptScrubber({ roomId: 'room', roomClient, durableMessages });
      return null;
    }
    await act(async () => {
      create(<Probe />);
    });
    expect(outline).toHaveBeenCalledTimes(1);
    expect(scrubber.history.total).toBe(3);
    expect(scrubber.history.days).toEqual([]);
    expect([...scrubber.history.rankById.values()]).toEqual([2, 1, 0]);
  });
});
