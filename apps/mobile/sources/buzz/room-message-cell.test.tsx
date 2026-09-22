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

vi.mock('@/components/buzz/Ledger', () => ({
  withLedgerDayCaption: (node: unknown, label: string | null) =>
    label
      ? React.createElement('day-caption-wrap', { label }, node as React.ReactNode)
      : node,
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

  it('hangs the day caption on the opener cell rather than inserting a list row', () => {
    const opener: ChatDisplayMessage = {
      id: 'opener',
      text: 'First of the day',
      isUser: true,
      timestamp: Math.floor(new Date(2026, 8, 17, 16, 58).getTime() / 1000),
    };
    const later: ChatDisplayMessage = {
      id: 'later',
      text: 'Same day',
      isUser: true,
      timestamp: Math.floor(new Date(2026, 8, 17, 17, 2).getTime() / 1000),
    };
    const render: RoomMessageRenderer = (item) =>
      React.createElement('message-row', { id: item.id });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(RoomMessageCell, { item: opener, render, continued: false }),
      );
    });
    expect(renderer.root.findByType('day-caption-wrap' as any).props.label).toBe('THU 17 SEP');
    expect(renderer.root.findByType('message-row' as any).props.id).toBe('opener');

    act(() => {
      renderer.update(
        React.createElement(RoomMessageCell, {
          item: later,
          render,
          continued: false,
          immediatelyPrecedingMessage: opener,
        }),
      );
    });
    expect(renderer.root.findAllByType('day-caption-wrap' as any)).toHaveLength(0);
    expect(renderer.root.findByType('message-row' as any).props.id).toBe('later');
  });

  it('places the first-new divider on the exact boundary row', () => {
    const message: ChatDisplayMessage = {
      id: 'host',
      text: 'New fact',
      isUser: false,
      timestamp: 1,
      foldedIds: ['host', 'first-new'],
    };
    const render: RoomMessageRenderer = (item) =>
      React.createElement('message-row', { id: item.id });
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(RoomMessageCell, {
          item: message,
          render,
          continued: false,
          startsNewMessages: true,
        }),
      );
    });

    expect(
      renderer.root.findAll(
        (node: { type: unknown; props: Record<string, unknown> }) =>
          node.type === 'View' && node.props.testID === 'new-messages-divider',
      ),
    ).toHaveLength(1);
    expect(renderer.root.findByType('message-row' as any).props.id).toBe('host');
  });
});
