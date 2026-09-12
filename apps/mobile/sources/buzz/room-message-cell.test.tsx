import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  RoomMessageCell,
  type RoomMessageRenderer,
  useRoomMessageRenderItem,
} from './room-message-cell';
import type { ChatDisplayMessage } from './room-view-presentation';

vi.mock('react-native', () => ({
  Text: (props: Record<string, unknown>) => React.createElement('Text', props),
  View: (props: Record<string, unknown>) => React.createElement('View', props),
}));

describe('RoomMessageCell', () => {
  it('does not rerender an identity-stable row when its parent list updates', () => {
    const message: ChatDisplayMessage = {
      id: 'message',
      text: 'Unchanged',
      isUser: false,
      timestamp: 1,
    };
    const render = vi.fn((item: ChatDisplayMessage) =>
      React.createElement('message-row', { text: item.text }),
    );
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(RoomMessageCell, { item: message, render, continued: false }),
      );
    });
    act(() => {
      renderer.update(
        React.createElement(RoomMessageCell, { item: message, render, continued: false }),
      );
    });
    expect(render).toHaveBeenCalledTimes(1);

    const changedMessage = { ...message, text: 'Changed' };
    act(() => {
      renderer.update(
        React.createElement(RoomMessageCell, {
          item: changedMessage,
          render,
          continued: false,
        }),
      );
    });
    expect(render).toHaveBeenCalledTimes(2);

    act(() => {
      renderer.update(
        React.createElement(RoomMessageCell, {
          item: changedMessage,
          render,
          continued: true,
        }),
      );
    });
    expect(render).toHaveBeenCalledTimes(3);
  });

  it('refreshes affected context through FlatList-compatible pure cell boundaries', () => {
    const message: ChatDisplayMessage = {
      id: 'message',
      text: 'Target',
      isUser: false,
      timestamp: 2,
    };
    const inserted: ChatDisplayMessage = {
      id: 'inserted',
      text: 'Late arrival',
      isUser: true,
      timestamp: 1,
    };
    const render = vi.fn<RoomMessageRenderer>((item, context) =>
      React.createElement('message-row', {
        text: item.text,
        precedingId: context.immediatelyPrecedingMessage?.id,
      }),
    );

    class FlatListCellBoundary extends React.PureComponent<{
      item: ChatDisplayMessage;
      renderItem: ({ item }: { item: ChatDisplayMessage }) => React.ReactNode;
    }> {
      override render() {
        return this.props.renderItem({ item: this.props.item });
      }
    }

    function Harness({
      precedingMessageById,
    }: {
      precedingMessageById: ReadonlyMap<string, ChatDisplayMessage>;
    }) {
      const renderItem = useRoomMessageRenderItem({
        render,
        continuedIds: new Set(),
        precedingMessageById,
        messageById: new Map(),
      });
      return React.createElement(FlatListCellBoundary, { item: message, renderItem });
    }

    const noPredecessor = new Map<string, ChatDisplayMessage>();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Harness, { precedingMessageById: noPredecessor }));
    });
    expect(renderer.root.findByType('message-row' as any).props.precedingId).toBeUndefined();

    act(() => {
      renderer.update(React.createElement(Harness, { precedingMessageById: noPredecessor }));
    });
    expect(render).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.update(
        React.createElement(Harness, {
          precedingMessageById: new Map([[message.id, inserted]]),
        }),
      );
    });
    expect(render).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType('message-row' as any).props.precedingId).toBe(inserted.id);
  });
});

it('places one divider before the unread row in either list order and breaks its byline group', () => {
  const messages: ChatDisplayMessage[] = ['read', 'unread', 'later'].map((id) => ({
    id,
    text: id,
    timestamp: 1,
    isUser: false,
  }));
  function List({ reverse, boundary }: { reverse: boolean; boundary: string | null }) {
    const renderItem = useRoomMessageRenderItem({
      firstUnreadMessageId: boundary,
      render: (item, context) =>
        React.createElement('row', { id: item.id, continued: context.continued }),
      continuedIds: new Set(['unread', 'later']),
      precedingMessageById: new Map(),
      messageById: new Map(),
    });
    return React.createElement(
      'list',
      {},
      (reverse ? [...messages].reverse() : messages).map((item) =>
        React.createElement(React.Fragment, { key: item.id }, renderItem({ item })),
      ),
    );
  }
  let renderer!: ReactTestRenderer;
  for (const reverse of [false, true]) {
    act(() => {
      renderer = create(React.createElement(List, { reverse, boundary: 'unread' }));
    });
    expect(
      renderer.root.findAll(
        (node: { type: unknown; props: Record<string, unknown> }) =>
          node.type === 'View' && node.props.testID === 'new-messages-divider',
      ),
    ).toHaveLength(1);
    expect(renderer.root.findByProps({ id: 'unread' }).props.continued).toBe(false);
    act(() => renderer.update(React.createElement(List, { reverse, boundary: null })));
    expect(
      renderer.root.findAll(
        (node: { type: unknown; props: Record<string, unknown> }) =>
          node.type === 'View' && node.props.testID === 'new-messages-divider',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  }
});
