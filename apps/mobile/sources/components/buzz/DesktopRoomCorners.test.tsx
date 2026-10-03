import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ChatListItem } from '@beeline/buzz-client';

vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { Pressable: host('Pressable'), Text: host('Text'), View: host('View') };
});
vi.mock('./CornerGlyph', () => ({ CornerGlyph: () => null, CORNER_META_SIZE: 12 }));
vi.mock('./CornerWaitingPulse', () => ({
  CornerWaitingPulse: ({ children }: { children: React.ReactNode }) => children,
}));

import { DesktopRoomCorners } from './DesktopRoomCorners';
import { beelineThemes } from '@/buzz/groknight';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('DesktopRoomCorners', () => {
  it('marks each corner name with the brass # every other corner name carries', () => {
    const item = {
      room: { id: 'room', name: 'alpha', updatedAt: 1 },
      openCorners: [{ id: 'c1', name: 'Docs refresh', state: 'working', mine: true }],
    } as unknown as ChatListItem;
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <DesktopRoomCorners item={item} onOpen={() => {}} renderDrag={(_id, child) => child} />,
      );
    });
    const name = tree.root
      .findByProps({ testID: 'desktop-corner-c1' })
      .findAllByType('Text' as never)[0]!;
    const [sigil, title] = name.props.children;
    expect(sigil.props.children).toBe('#');
    expect(sigil.props.style.color).toBe(beelineThemes.obsidian.accent);
    expect(title).toBe('Docs refresh');
  });
});
