import React, { useState } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { PhoneTranscriptList } from './PhoneTranscriptList.android';

// Keep one recycler slot mounted while its message changes, as FlashList does.
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: any) => React.createElement('FlashList', props,
    props.renderItem({ item: props.data[0], index: 0, target: 'Cell' })),
}));
vi.mock('react-native-unistyles', () => ({ withUnistyles: (component: any) => component }));

describe('Android transcript recycling', () => {
  it('keeps expansion, swipe, attachment and draft state with their message', async () => {
    const RowLayout = ({ children, cellKey }: any) =>
      React.createElement('RowLayout', { cellKey }, children);
    function StatefulMessage({ item }: any) {
      const [expanded, expand] = useState(false);
      const [swipe, setSwipe] = useState(0);
      const [attachment, selectAttachment] = useState<string | null>(null);
      const [draft, setDraft] = useState(item.draft);
      return React.createElement('Message' as any, {
        id: item.id, expanded, swipe, attachment, draft,
        change() { expand(true); setSwipe(80); selectAttachment(item.id); setDraft('edited'); },
      });
    }
    const props = {
      keyExtractor: (item: any) => `window:${item.id}`,
      CellRendererComponent: RowLayout,
      renderItem: ({ item }: any) => <StatefulMessage item={item} />,
    };
    let tree: any;
    await act(async () => {
      tree = create(<PhoneTranscriptList {...props} data={[{ id: 'a', draft: 'first' }]} />);
    });
    await act(async () => tree.root.findByType('Message').props.change());
    expect(tree.root.findByType('Message').props.expanded).toBe(true);
    await act(async () => {
      tree.update(<PhoneTranscriptList {...props} data={[{ id: 'b', draft: 'second' }]} />);
    });
    const recycled = tree.root.findByType('Message').props;
    expect([recycled.id, recycled.expanded, recycled.swipe, recycled.attachment, recycled.draft])
      .toEqual(['b', false, 0, null, 'second']);
    expect(tree.root.findByType('RowLayout').props.cellKey).toBe('window:b');
    // A streaming update to the same message must keep local interaction state.
    await act(async () => tree.root.findByType('Message').props.change());
    await act(async () => {
      tree.update(<PhoneTranscriptList {...props} data={[{ id: 'b', draft: 'stream grew' }]} />);
    });
    expect(tree.root.findByType('Message').props.draft).toBe('edited');
    await act(async () => tree.unmount());
  });

  it('retains anchoring while omitting automatic following for a historical window', async () => {
    let tree: any;
    await act(async () => {
      tree = create(<PhoneTranscriptList data={['row']} renderItem={() => null}
        maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 50 }} />);
    });
    expect(tree.root.findByType('FlashList').props.maintainVisibleContentPosition)
      .toEqual({ autoscrollToTopThreshold: 50 });
    await act(async () => {
      tree.update(<PhoneTranscriptList data={['row']} renderItem={() => null}
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }} />);
    });
    expect(tree.root.findByType('FlashList').props.maintainVisibleContentPosition)
      .toEqual({ autoscrollToTopThreshold: undefined });
    await act(async () => tree.unmount());
  });
});
