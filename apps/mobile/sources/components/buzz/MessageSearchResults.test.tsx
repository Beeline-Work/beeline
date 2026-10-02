import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageSearchResult } from '@beeline/api-contract/phone';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Pressable: host('Pressable'), Text: host('Text'), View: host('View') };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));

import { MessageSearchResults } from './MessageSearchResults';
import type { MessageSearchState } from '@/buzz/use-message-search';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());

const NOW = Date.parse('2026-10-02T12:00:00Z');
const ROOM = '22222222-2222-4222-8222-222222222221';

const result = (id: string, extra: Partial<MessageSearchResult> = {}): MessageSearchResult => ({
  messageId: id.repeat(64),
  roomId: ROOM,
  roomName: 'mobile',
  directMessage: false,
  authorName: 'Sol',
  createdAt: NOW / 1_000 - 2 * 86_400,
  snippet: [
    { text: 'Looking. The ', match: false },
    { text: 'Android', match: true },
    { text: ' ', match: false },
    { text: 'build', match: true },
    { text: ' failed.', match: false },
  ],
  ...extra,
});

const state = (extra: Partial<MessageSearchState>): MessageSearchState => ({
  status: 'ready',
  results: [],
  hasMore: false,
  loadingMore: false,
  moreFailed: false,
  retry: () => undefined,
  loadMore: () => undefined,
  ...extra,
});

function textOf(node: any): string {
  return node.children
    .map((child: any) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

async function render(search: MessageSearchState, onOpen = vi.fn()) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(MessageSearchResults, { search, now: NOW, onOpen }));
  });
  const find = (testID: string) => tree.root.findAll((node: any) => node.props.testID === testID);
  return { tree, find, onOpen };
}

describe('MessageSearchResults', () => {
  it('lists each match under Messages with its Room, author, age and highlighted words', async () => {
    const { tree, find } = await render(
      state({
        results: [
          result('1'),
          result('2', { roomName: 'sol', directMessage: true, authorName: 'Ada' }),
        ],
      }),
    );
    expect(textOf(tree.root)).toContain('MESSAGES');
    const [room, direct] = [find(`message-search-result-${'1'.repeat(64)}`)[0], find(`message-search-result-${'2'.repeat(64)}`)[0]];
    expect(textOf(room)).toBe('#mobile2dSol: Looking. The Android build failed.');
    expect(textOf(direct)).toBe('@sol2dAda: Looking. The Android build failed.');
    expect(
      tree.root
        .findAll((node: any) => node.type === 'Text' && node.props.testID === 'message-search-match')
        .map(textOf),
    ).toEqual(['Android', 'build', 'Android', 'build']);
  });

  it('opens the tapped result', async () => {
    const tapped = result('3');
    const { find, onOpen } = await render(state({ results: [result('1'), tapped] }));
    await act(async () => find(`message-search-result-${'3'.repeat(64)}`)[0].props.onPress());
    expect(onOpen).toHaveBeenCalledWith(tapped);
  });

  it('says when nothing matches, offers Retry after a failure, and pages with Show more', async () => {
    expect(textOf((await render(state({}))).find('message-search-empty')[0])).toBe('No messages match');

    const retry = vi.fn();
    const failed = await render(state({ status: 'error', retry }));
    await act(async () => failed.find('message-search-retry')[0].props.onPress());
    expect(retry).toHaveBeenCalledTimes(1);

    const loadMore = vi.fn();
    const more = await render(state({ results: [result('1')], hasMore: true, loadMore }));
    await act(async () => more.find('message-search-more')[0].props.onPress());
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('renders nothing until the query is long enough to search', async () => {
    const { tree } = await render(state({ status: 'unavailable' }));
    expect(tree.toJSON()).toBeNull();
  });
});
