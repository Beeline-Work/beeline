import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';

import { useRoomTranscriptHistory } from './use-room-transcript-history';

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

const message = (id: string, createdAt: number): RoomViewMessage => ({
  id: id.repeat(64),
  createdAt,
  text: `message-${id}`,
  presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function Transcript({
  tail,
  history,
  corner = true,
}: {
  tail: readonly RoomViewMessage[];
  history: (roomId: string, before: { createdAt: number; id: string }) => Promise<RoomHistoryView>;
  corner?: boolean;
}) {
  const page = useRoomTranscriptHistory({
    roomId: 'corner',
    tailMessages: tail,
    roomClient: { history },
    enabled: true,
    initialVisibleCount: 2,
  });
  const rows = [...page.olderPages.flat(), ...tail].slice(-page.visibleMessageCount);
  const line =
    page.status === 'loading'
      ? 'Loading earlier messages…'
      : page.status === 'error'
        ? "Couldn't load earlier messages · tap to retry"
        : page.status === 'complete'
          ? corner
            ? 'Beginning of corner'
            : 'Beginning of Room'
          : null;
  return React.createElement(
    'Transcript',
    {
      onEndReached: () => page.loadOlder(rows.length),
      onRetry: () => page.retry(rows.length),
    },
    line ? React.createElement('HistoryLine', null, line) : null,
    rows.map((row) => React.createElement('Message', { key: row.id }, row.text)),
  );
}

function textRows(renderer: ReactTestRenderer, type: string): string[] {
  return renderer.root
    .findAllByType(type)
    .map((node: { children: readonly unknown[] }) => node.children.join(''));
}

describe('Room transcript history', () => {
  it('shows loading at the top, then prepends the previous page without replacing the first row', async () => {
    const request = deferred<RoomHistoryView>();
    const history = vi.fn(() => request.promise);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Transcript tail={[message('3', 30), message('4', 40)]} history={history} />,
      );
    });

    act(() => renderer.root.findByType('Transcript').props.onEndReached());
    expect(textRows(renderer, 'HistoryLine')).toEqual(['Loading earlier messages…']);
    expect(history).toHaveBeenCalledWith('corner', { createdAt: 30, id: '3'.repeat(64) });

    await act(async () => {
      request.resolve({
        roomId: 'corner',
        messages: [message('1', 10), message('2', 20)],
        nextBefore: { createdAt: 10, id: '1'.repeat(64) },
      });
      await request.promise;
    });

    expect(textRows(renderer, 'Message')).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
  });

  it('marks the beginning when the server returns the first page', async () => {
    const history = vi.fn(async () => ({ roomId: 'corner', messages: [message('1', 10)] }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Transcript tail={[message('2', 20), message('3', 30)]} history={history} />,
      );
    });

    await act(async () => renderer.root.findByType('Transcript').props.onEndReached());

    expect(textRows(renderer, 'HistoryLine')).toEqual(['Beginning of corner']);
    act(() => renderer.root.findByType('Transcript').props.onEndReached());
    expect(history).toHaveBeenCalledTimes(1);
  });

  it('holds a failed page for an explicit tap-to-retry', async () => {
    const retry = deferred<RoomHistoryView>();
    const history = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => retry.promise);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Transcript tail={[message('2', 20), message('3', 30)]} history={history} />,
      );
    });

    await act(async () => renderer.root.findByType('Transcript').props.onEndReached());
    expect(textRows(renderer, 'HistoryLine')).toEqual([
      "Couldn't load earlier messages · tap to retry",
    ]);

    act(() => renderer.root.findByType('Transcript').props.onEndReached());
    expect(history).toHaveBeenCalledTimes(1);
    act(() => renderer.root.findByType('Transcript').props.onRetry());
    expect(textRows(renderer, 'HistoryLine')).toEqual(['Loading earlier messages…']);

    await act(async () => {
      retry.resolve({ roomId: 'corner', messages: [message('1', 10)] });
      await retry.promise;
    });
    expect(textRows(renderer, 'HistoryLine')).toEqual(['Beginning of corner']);
    expect(history).toHaveBeenCalledTimes(2);
  });
});
