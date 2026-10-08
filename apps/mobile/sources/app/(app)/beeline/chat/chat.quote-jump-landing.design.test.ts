import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import { messageJumpHref } from '@/buzz/corner-navigation';

const message = (digit: string, createdAt: number): RoomViewMessage => ({
  id: digit.repeat(64),
  createdAt,
  text: digit,
  presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
});

it.each(['quote', 'notification', 'bookmark'])(
  '%s reads a distant target into the window once',
  async (source) => {
    const target = message('b', 2);
    const route = messageJumpHref('room', target.id, `${source}:${target.id}`);
    const around = vi.fn(async (): Promise<RoomHistoryView> => ({
      roomId: 'room',
      messages: [message('a', 1), target, message('c', 3)],
    }));
    const history = vi.fn(async (): Promise<RoomHistoryView> => ({ roomId: 'room', messages: [] }));
    let state: ReturnType<typeof useRoomMessageStore>;
    function Probe() {
      state = useRoomMessageStore({
        roomId: route.params.channelId,
        tailMessages: [message('f', 6)],
        roomClient: { history, historyAround: around },
        enabled: true,
        initialVisibleCount: 1,
      });
      return React.createElement('Probe');
    }
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      state!.jumpTo(route.params.notificationMessageId);
    });
    expect(around).toHaveBeenCalledExactlyOnceWith('room', target.id);
    expect(history).not.toHaveBeenCalled();
    expect(state!.jump).toEqual({ messageId: target.id, status: 'ready' });
    expect(state!.rows.map((row) => row.id)).toContain(target.id);
    await act(async () => {
      renderer!.unmount();
    });
  },
);

describe('message-source landing', () => {
  const surface = readFileSync(path.join(__dirname, '_chat-surface.tsx'), 'utf8');

  it('never covers the room while a target loads', () => {
    expect(surface).not.toContain('Locating message');
    expect(surface).not.toContain('message-source-locating');
    expect(surface).not.toContain('isLocatingMessageSource');
  });

  it('lands with one scroll to the top of the screen, without estimated offsets or timers', () => {
    expect(surface).toContain(
      "scrollController.request({ kind: 'message', messageId, align: 'top', jump: true });",
    );
    const controller = readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'buzz', 'transcript-scroll-controller.ts'),
      'utf8',
    );
    // Top of the screen on the inverted phone list.
    expect(controller).toContain("viewPosition: align === 'top' ? 1 : 0.5");
    expect(controller).not.toContain('setTimeout');
    // Only the unread landing estimates an offset; a message jump waits for
    // the next layout pass instead.
    expect(controller).toContain(
      "if (destination.kind === 'firstUnread') list.toEstimatedRow(index);",
    );
    expect(surface).toContain('onScrollToIndexFailed={phoneScrollList.scrollToIndexFailed}');
  });
});
