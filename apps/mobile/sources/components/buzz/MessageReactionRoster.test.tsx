import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { beelineThemes } from '@/buzz/groknight';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(
      name,
      props,
      typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
    );
  return {
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: (theme: { buzz: typeof beelineThemes.obsidian }) => unknown) =>
      factory({ buzz: beelineThemes.obsidian }),
  },
}));

vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('./HullDialog', async () => {
  const ReactModule = await import('react');
  return {
    HullFloatingSurface: (props: any) =>
      ReactModule.createElement('HullFloatingSurface', props, props.children),
  };
});
vi.mock('./HullActionSheet', async () => {
  const ReactModule = await import('react');
  return {
    HULL_SHEET_INSET: 22,
    HullActionSheetModal: (props: any) =>
      ReactModule.createElement('HullActionSheetModal', props, props.children),
    HullActionSheetCancel: (props: any) =>
      ReactModule.createElement('HullActionSheetCancel', props),
  };
});

import { MessageReactionRoster } from './MessageReactionRoster';

const members = [
  { pubkey: 'person', kind: 'human' as const, name: 'Ada', handle: 'ada', face: 'fox' },
  { pubkey: 'agent', kind: 'agent' as const, name: 'Milo', handle: 'milo', face: 'owl' },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('MessageReactionRoster', () => {
  it('opens a touch sheet on long press without toggling the reaction', () => {
    const onReact = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <MessageReactionRoster
          desktop={false}
          messageId="message"
          onReact={onReact}
          reaction={{ emoji: '👍', count: 1, reacted: false, members: [members[0]!] }}
        />,
      );
    });
    const chip = renderer.root.findByProps({ testID: 'reaction-chip-message-👍' });
    expect(renderer.root.findAllByProps({ testID: 'reaction-sheet-message-👍' })).toHaveLength(0);

    act(() => chip.props.onLongPress());
    expect(renderer.root.findByType('HullActionSheetModal' as any).props.visible).toBe(true);
    act(() => chip.props.onPress());
    expect(onReact).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('IdentityMark' as any)).toHaveLength(1);
  });

  it('keeps the count chip when the server omits reaction members', () => {
    const onReact = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <MessageReactionRoster
          desktop={false}
          messageId="message"
          onReact={onReact}
          reaction={{ emoji: '👍', count: 3, reacted: false }}
        />,
      );
    });
    const chip = renderer.root.findByProps({ testID: 'reaction-chip-message-👍' });
    expect(chip.props.accessibilityLabel).toBe('👍, 3 reactions');
    expect(renderer.root.findByProps({ testID: 'reaction-roster-anchor-message-👍' })).toBeDefined();
    act(() => chip.props.onLongPress?.());
    expect(renderer.root.findAllByProps({ testID: 'reaction-sheet-message-👍' })).toHaveLength(0);
    expect(renderer.root.findAllByType('IdentityMark' as any)).toHaveLength(0);
  });

  it('shows every member in a desktop hover popover and still toggles on press', () => {
    const onReact = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <MessageReactionRoster
          desktop
          messageId="message"
          onReact={onReact}
          reaction={{ emoji: '🎉', count: 2, reacted: true, members }}
        />,
      );
    });
    const anchor = renderer.root.findByProps({ testID: 'reaction-roster-anchor-message-🎉' });
    expect(renderer.root.findAllByProps({ testID: 'reaction-popover-message-🎉' })).toHaveLength(0);

    act(() => anchor.props.onMouseEnter());
    expect(renderer.root.findAllByType('HullFloatingSurface' as any)).toHaveLength(1);
    expect(renderer.root.findAllByType('IdentityMark' as any)).toHaveLength(2);

    act(() => renderer.root.findByProps({ testID: 'reaction-chip-message-🎉' }).props.onPress());
    expect(onReact).toHaveBeenCalledOnce();
  });
});
