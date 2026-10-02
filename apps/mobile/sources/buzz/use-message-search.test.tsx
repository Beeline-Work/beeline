import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomViewHttpError } from '@beeline/buzz-client';
import type { MessageSearchResult, MessageSearchView } from '@beeline/api-contract/phone';

import {
  MESSAGE_SEARCH_DEBOUNCE_MS,
  messageSearchHref,
  useMessageSearch,
  type MessageSearchRead,
  type MessageSearchState,
} from './use-message-search';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const result = (id: string): MessageSearchResult => ({
  messageId: id.repeat(64),
  roomId: '22222222-2222-4222-8222-222222222221',
  roomName: 'mobile',
  directMessage: false,
  authorName: 'Sol',
  createdAt: 1,
  snippet: [{ text: 'android', match: true }],
});
const view = (ids: string[], nextBefore?: string): MessageSearchView => ({
  workspaceId: WORKSPACE,
  results: ids.map(result),
  ...(nextBefore ? { nextBefore } : {}),
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

function harness(read: MessageSearchRead) {
  let latest!: MessageSearchState;
  function Probe({ query }: { query: string }) {
    // A new function every render, as an inline caller passes it.
    latest = useMessageSearch((...args) => read(...args), WORKSPACE, query);
    return null;
  }
  let tree!: ReactTestRenderer;
  return {
    state: () => latest,
    type: async (query: string) => {
      await act(async () => {
        if (tree) tree.update(React.createElement(Probe, { query }));
        else tree = create(React.createElement(Probe, { query }));
      });
    },
    settle: async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MESSAGE_SEARCH_DEBOUNCE_MS);
      });
    },
  };
}

describe('useMessageSearch', () => {
  it('waits for typing to pause, needs four characters, and asks once for the settled query', async () => {
    const read = vi.fn(async () => view(['1']));
    const search = harness(read);
    for (const query of ['a', 'an', 'and']) {
      await search.type(query);
      await search.settle();
      expect(search.state().status).toBe('short');
    }
    expect(read).not.toHaveBeenCalled();

    await search.type('andr');
    await search.type('andro');
    expect(search.state().status).toBe('loading');
    await search.settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(WORKSPACE, 'andro', undefined, expect.any(AbortSignal));
    expect(search.state().status).toBe('ready');
    expect(search.state().results.map((item) => item.messageId)).toEqual(['1'.repeat(64)]);
  });

  it('never asks for a query of only common words or a word still too short', async () => {
    const read = vi.fn(async () => view(['1']));
    const search = harness(read);
    for (const query of ['with', 'yeah thanks', 'the bu']) {
      await search.type(query);
      await search.settle();
      expect(search.state().status).toBe('filler');
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('does not ask again while the searched words stay the same', async () => {
    const read = vi.fn(async () => view(['1']));
    const search = harness(read);
    await search.type('android b');
    await search.settle();
    await search.type('android bu');
    await search.settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(search.state().status).toBe('ready');
  });

  it('cancels the read in flight when the query changes and shows no error for it', async () => {
    const signals: AbortSignal[] = [];
    const read = vi.fn<MessageSearchRead>((_workspace, _query, _before, signal) => {
      signals.push(signal!);
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
      );
    });
    const search = harness(read);
    await search.type('android');
    await search.settle();
    await search.type('gradle');
    expect(signals[0]!.aborted).toBe(true);
    expect(search.state().status).toBe('loading');
    await search.settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(signals[1]!.aborted).toBe(false);
    expect(search.state().status).toBe('loading');
  });

  it('cancels a Show more read when the query changes', async () => {
    const more = deferred<MessageSearchView>();
    let moreSignal!: AbortSignal;
    const read = vi
      .fn<MessageSearchRead>()
      .mockResolvedValueOnce(view(['3'], '3'.repeat(64)))
      .mockImplementationOnce((_workspace, _query, _before, signal) => {
        moreSignal = signal!;
        return more.promise;
      })
      .mockResolvedValueOnce(view(['5']));
    const search = harness(read);
    await search.type('android');
    await search.settle();
    await act(async () => search.state().loadMore());
    await search.type('gradle');
    expect(moreSignal.aborted).toBe(true);
    await search.settle();
    await act(async () => more.reject(new DOMException('Aborted', 'AbortError')));
    expect(search.state().status).toBe('ready');
    expect(search.state().moreFailed).toBeNull();
    expect(search.state().results.map((item) => item.messageId)).toEqual(['5'.repeat(64)]);
  });

  it('tells searching too fast and a too-broad query apart from other failures', async () => {
    const read = vi
      .fn<MessageSearchRead>()
      .mockRejectedValueOnce(new RoomViewHttpError(429, 'too_many_requests'))
      .mockRejectedValueOnce(new RoomViewHttpError(422, 'query_too_broad'))
      .mockResolvedValueOnce(view(['1']));
    const search = harness(read);
    await search.type('gradle');
    await search.settle();
    expect(search.state().status).toBe('rate_limited');
    await act(async () => search.state().retry());
    await search.settle();
    expect(search.state().status).toBe('too_broad');
    expect(search.state().query).toBe('gradle');
    await act(async () => search.state().retry());
    await search.settle();
    expect(search.state().status).toBe('ready');
  });

  it('drops a response for a query that has since changed', async () => {
    const first = deferred<MessageSearchView>();
    const read = vi
      .fn<MessageSearchRead>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(view(['2']));
    const search = harness(read);
    await search.type('android');
    await search.settle();
    await search.type('build');
    await search.settle();
    await act(async () => first.resolve(view(['1'])));
    expect(search.state().results.map((item) => item.messageId)).toEqual(['2'.repeat(64)]);
  });

  it('shows an error that Retry asks again for, and Show more appends the next page', async () => {
    const read = vi
      .fn<MessageSearchRead>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(view(['3'], '3'.repeat(64)))
      .mockResolvedValueOnce(view(['2']));
    const search = harness(read);
    await search.type('android');
    await search.settle();
    expect(search.state().status).toBe('error');

    await act(async () => search.state().retry());
    await search.settle();
    expect(search.state().status).toBe('ready');
    expect(search.state().hasMore).toBe(true);

    await act(async () => search.state().loadMore());
    expect(read).toHaveBeenLastCalledWith(WORKSPACE, 'android', '3'.repeat(64), expect.any(AbortSignal));
    expect(search.state().results.map((item) => item.messageId)).toEqual([
      '3'.repeat(64),
      '2'.repeat(64),
    ]);
    expect(search.state().hasMore).toBe(false);
  });

  it('stays unavailable on a server without message search', async () => {
    const search = harness(async () => null);
    await search.type('android');
    await search.settle();
    expect(search.state().status).toBe('unavailable');
  });
});

describe('messageSearchHref', () => {
  it('opens the Room on the message with a fresh landing every tap', () => {
    const first = messageSearchHref(result('4'), WORKSPACE);
    const second = messageSearchHref(result('4'), WORKSPACE);
    expect(first.pathname).toBe('/beeline/chat/[channelId]');
    expect(first.params).toMatchObject({
      channelId: '22222222-2222-4222-8222-222222222221',
      communityId: WORKSPACE,
      notificationMessageId: '4'.repeat(64),
    });
    expect(first.params.notificationResponseId).not.toBe(second.params.notificationResponseId);
  });
});
