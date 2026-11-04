import React, { Profiler, useEffect } from 'react';
// @ts-expect-error no declarations for react-test-renderer in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { RoomSendList, RoomSendPreview } from './room-send-list';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({ props: null as any }));
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    View: 'preview-row',
    FlatList: React.forwardRef((props: any, _ref) => {
      capture.props = props;
      const Cell = props.CellRendererComponent as React.ComponentType<any>;
      return React.createElement('list', null, props.ListHeaderComponent, props.data.map((item: ChatDisplayMessage, index: number) =>
        React.createElement(Cell, { key: props.keyExtractor(item, index), item, index,
          cellKey: props.keyExtractor(item, index), children: props.renderItem({ item, index }),
          onLayout: vi.fn() }),
      ));
    }),
  };
});

const message = (id: string) => ({ id, text: id, timestamp: 1, isUser: true } satisfies ChatDisplayMessage);
const Cell = (props: any) => React.createElement('cell', { id: props.item.id, onLayout: props.onLayout }, props.children);

function mockFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  return frames;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('native send first frame', () => {
  it('SEND-LIST-1: commits only the new row, with no Room render or history sort, then hands off with the same key', async () => {
    const preview = new RoomSendPreview();
    const frames = mockFrames();
    const old = Object.freeze(Array.from({ length: 100 }, (_, i) => Object.freeze(message(`old-${i}`))));
    const bodies: string[] = [], mounts: string[] = [];
    let parentRenders = 0;
    const profiles: { phase: string; duration: number }[] = [];
    const Row = React.memo(function Row({ item }: { item: ChatDisplayMessage }) {
      bodies.push(item.id);
      useEffect(() => { mounts.push(item.id); }, []);
      return React.createElement('body', { id: item.id });
    });
    const renderItem = ({ item }: { item: ChatDisplayMessage }) => <Row item={item} />;
    const anchor = { minIndexForVisible: 0, autoscrollToTopThreshold: 50 };
    function Room({ rows }: { rows: ChatDisplayMessage[] }) {
      parentRenders++;
      return <Profiler id="list" onRender={(_, phase, duration) => profiles.push({ phase, duration })}>
        <RoomSendList preview={preview} data={rows} CellRendererComponent={Cell}
          maintainVisibleContentPosition={anchor} renderItem={renderItem} keyExtractor={item => `window:${item.id}`} />
      </Profiler>;
    }
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(<Room rows={old as unknown as ChatDisplayMessage[]} />); });
    bodies.length = 0;
    const sort = vi.spyOn(Array.prototype, 'sort');
    let painted = false;
    let firstPaint!: Promise<void>;
    act(() => { firstPaint = preview.show(message('pending')).then(() => { painted = true; }); });
    expect(parentRenders).toBe(1);
    expect(bodies).toEqual(['pending']);
    expect(capture.props.data).toBe(old);
    expect(capture.props.maintainVisibleContentPosition).toBeUndefined();
    expect(sort.mock.contexts.some(value => Array.isArray(value) && value.includes(old[0]))).toBe(false);
    expect(painted).toBe(false);
    act(() => renderer.root.findByType('preview-row').props.onLayout({}));
    expect(painted).toBe(false);
    frames.shift()!(0);
    await act(async () => { await firstPaint; });
    expect(painted).toBe(true);
    expect(capture.props.maintainVisibleContentPosition).toBe(anchor);
    bodies.length = 0;
    act(() => preview.reconcile('pending', 'signed'));
    expect(bodies).toEqual(['signed']);
    expect(capture.props.keyExtractor(message('signed'), 0)).toBe('window:pending');
    bodies.length = 0;
    act(() => renderer.update(<Room rows={[message('signed'), ...old]} />));
    expect(preview.snapshot()).toBe(null);
    expect(capture.props.data[0].id).toBe('signed');
    expect(bodies).toEqual(['signed']);
    expect(mounts.filter(id => id === 'pending' || id === 'signed')).toEqual(['pending', 'signed']);
    expect(profiles.every(profile => profile.duration >= 0)).toBe(true);
    act(() => renderer.unmount());
    preview.dispose();
  });

  it('holds transcript bookkeeping until layout and the following frame, coalescing stale measurements', async () => {
    const preview = new RoomSendPreview(), frames = mockFrames(), onSize = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(<RoomSendList preview={preview} data={[]} CellRendererComponent={Cell}
      onContentSizeChange={onSize} renderItem={({ item }) => React.createElement('body', { id: item.id })} />); });
    let painted!: Promise<void>;
    act(() => { painted = preview.show(message('new')); });
    act(() => { capture.props.onContentSizeChange(20, 10); capture.props.onContentSizeChange(20, 30); });
    expect(onSize).not.toHaveBeenCalled();
    preview.laidOut('unrelated');
    expect(frames).toHaveLength(0);
    preview.laidOut('new');
    preview.laidOut('new');
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    await act(async () => { await painted; });
    expect(onSize.mock.calls).toEqual([[20, 30]]);
    act(() => renderer.unmount());
    preview.dispose();
  });

  it('releases an interrupted send on unmount and never reopens it from a late frame', async () => {
    const preview = new RoomSendPreview(), frames = mockFrames();
    const painted = preview.show(message('old'));
    preview.laidOut('old');
    preview.dispose();
    await painted;
    frames.shift()!(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(preview.snapshot()).toBe(null);
    expect(preview.key('old')).toBe('old');
    await preview.show(message('after-unmount'));
    expect(preview.snapshot()).toBe(null);
    preview.activate();
    const next = preview.show(message('new-room'));
    preview.dispose();
    await next;
  });
});
