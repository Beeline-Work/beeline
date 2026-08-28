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
