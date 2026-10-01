import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const scrollTo = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  const ScrollView = ReactModule.forwardRef((props: any, ref) => {
    ReactModule.useImperativeHandle(ref, () => ({ scrollTo }));
    return ReactModule.createElement('ScrollView', props, props.children);
  });
  return {
    ScrollView,
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  return {
    StyleSheet: {
      create: (factory: (theme: { buzz: typeof beelineThemes.obsidian }) => unknown) =>
        factory({ buzz: beelineThemes.obsidian }),
    },
  };
});

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});

import { typeRoles } from '@/buzz/groknight';
import { CHANNEL_MENTION_PUBKEY, SYSTEM_MENTION_PUBKEY } from '@/buzz/room-participants';
import type { RoomRosterParticipant } from './RoomRosterSheet';
import { MENTION_ROW_HEIGHT, MentionSuggestionMenu } from './MentionSuggestionMenu';

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

const matches: RoomRosterParticipant[] = [
  { pubkey: CHANNEL_MENTION_PUBKEY, name: 'channel', handle: 'channel', kind: 'person' },
  { pubkey: 'p-ada', name: 'Ada Lovelace', handle: 'ada', kind: 'person' },
  { pubkey: 'p-bo', name: 'Bo', handle: 'bo', kind: 'person' },
  { pubkey: 'p-cy', name: 'Cy', handle: 'cy', kind: 'person' },
  { pubkey: 'p-di', name: 'Di', handle: 'di', kind: 'person' },
  { pubkey: 'p-ed', name: 'Ed', handle: 'ed', kind: 'person' },
];

function menu(props: Partial<React.ComponentProps<typeof MentionSuggestionMenu>> = {}) {
  return (
    <MentionSuggestionMenu
      highlightedIndex={0}
      keyboardOpen
      matches={matches}
      onSelect={() => undefined}
      overflow={3}
      personAvatar={() => undefined}
      {...props}
    />
  );
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function flat(style: unknown): Record<string, unknown> {
  return Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style as any);
}

describe('MentionSuggestionMenu', () => {
  it('caps the scroll area at 3 rows with the keyboard open and 5 rows with it closed', () => {
    const renderer = render(menu({ keyboardOpen: true }));
    const scroll = () => renderer.root.findByProps({ testID: 'mention-suggestion-scroll' });
    expect(flat(scroll().props.style).maxHeight).toBe(132);
    expect(scroll().props.keyboardShouldPersistTaps).toBe('handled');
    act(() => renderer.update(menu({ keyboardOpen: false })));
    expect(flat(scroll().props.style).maxHeight).toBe(220);
  });

  it('keeps the MENTION label outside the scroll area and the overflow line inside it', () => {
    const renderer = render(menu());
    const root = renderer.root.findByProps({ testID: 'mention-suggestions' });
    expect(root.props.accessibilityLabel).toBe('Mention a Room participant');
    const scroll = renderer.root.findByProps({ testID: 'mention-suggestion-scroll' });
    const label = root.findAll(
      (node: any) => node.type === 'Text' && node.props.children === 'MENTION',
    );
    expect(label).toHaveLength(1);
    expect(scroll.findAll((node: any) => node === label[0])).toHaveLength(0);
    const overflow = scroll.findByProps({ testID: 'mention-suggestion-overflow' });
    expect(overflow.props.children).toEqual(['AND ', 3, ' OTHERS']);
  });

  it('renders each row as one 44pt line with 24pt marks and 13pt name and handle', () => {
    const renderer = render(menu());
    const row = renderer.root.findByProps({ testID: 'mention-suggestion-ada' });
    expect(row.props.accessibilityLabel).toBe('Ada Lovelace, @ada, person');
    expect(flat(row.props.style).height).toBe(MENTION_ROW_HEIGHT);
    expect(MENTION_ROW_HEIGHT).toBe(44);
    expect(row.findByType('IdentityMark' as never).props.size).toBe(24);
    const [identity] = row.findAll(
      (node: any) => node.type === 'View' && flat(node.props.style)?.flexDirection === 'row',
    );
    expect(flat(identity.props.style).flexDirection).toBe('row');
    const [name, handle] = identity.findAllByType('Text' as never);
    expect(name.props.children).toBe('Ada Lovelace');
    expect(name.props.numberOfLines).toBe(1);
    expect(flat(name.props.style).fontSize).toBe(typeRoles.meta.fontSize);
    expect(handle.props.children).toEqual(['@', 'ada']);
    expect(handle.props.numberOfLines).toBe(1);
    expect(flat(handle.props.style).fontSize).toBe(typeRoles.machine.fontSize);
    expect(typeRoles.meta.fontSize).toBe(13);
    expect(typeRoles.machine.fontSize).toBe(13);

    const channel = renderer.root.findByProps({ testID: `mention-suggestion-channel` });
    const glyph = channel.findAll(
      (node: any) => node.type === 'View' && flat(node.props.style)?.width === 24,
    );
    expect(glyph).toHaveLength(1);
    expect(flat(glyph[0].props.style).height).toBe(24);
    expect(
      JSON.stringify(channel.findAllByType('Text' as never).map((t: any) => t.props.children)),
    ).toContain('Everyone in this Room');
  });

  it('shows an agent as its handle, then model by @owner, without repeating its name', () => {
    const agent: RoomRosterParticipant = {
      pubkey: 'a-niglet',
      name: 'Niglet',
      handle: 'niglet',
      kind: 'agent',
      agent: { pubkey: 'a-niglet', displayName: 'Niglet' },
      model: 'claude-opus-5-5',
      ownerHandle: 'lunchboxfortwo',
    };
    const renderer = render(menu({ matches: [agent], overflow: 0 }));
    const row = renderer.root.findByProps({ testID: 'mention-suggestion-niglet' });
    const words = row
      .findAllByType('Text' as never)
      .map((text: any) => [text.props.children].flat().join(''));
    expect(words).toEqual(['@niglet', 'claude-opus-5-5 · by @lunchboxfortwo']);
    expect(row.props.accessibilityLabel).toBe(
      '@niglet, claude-opus-5-5 · by @lunchboxfortwo, agent',
    );
  });

  it('offers @system as a report row, not a person', () => {
    const system: RoomRosterParticipant = {
      pubkey: SYSTEM_MENTION_PUBKEY,
      name: 'System',
      handle: 'system',
      kind: 'person',
    };
    const onSelect = vi.fn();
    const renderer = render(menu({ matches: [system], overflow: 0, onSelect }));
    const row = renderer.root.findByProps({ testID: 'mention-suggestion-system' });
    expect(row.props.accessibilityLabel).toBe('System — report an issue, @system');
    const words = JSON.stringify(
      row.findAllByType('Text' as never).map((text: any) => text.props.children),
    );
    expect(words).toContain('System — report an issue');
    expect(words).toContain('REPORT');
    expect(words).not.toContain('PERSON');
    // A token, not an identity: no face.
    expect(row.findAllByType('IdentityMark' as never)).toHaveLength(0);
    act(() => row.props.onPress());
    expect(onSelect).toHaveBeenCalledWith(system);
  });

  it('selects on press', () => {
    const onSelect = vi.fn();
    const renderer = render(menu({ onSelect }));
    act(() => renderer.root.findByProps({ testID: 'mention-suggestion-bo' }).props.onPress());
    expect(onSelect).toHaveBeenCalledWith(matches[2]);
  });

  it('scrolls a highlighted row outside the visible window into view', () => {
    scrollTo.mockClear();
    const renderer = render(menu({ highlightedIndex: 0 }));
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => renderer.update(menu({ highlightedIndex: 2 })));
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => renderer.update(menu({ highlightedIndex: 4 })));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 2 * MENTION_ROW_HEIGHT, animated: false });
    const scroll = renderer.root.findByProps({ testID: 'mention-suggestion-scroll' });
    act(() =>
      scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 2 * MENTION_ROW_HEIGHT } } }),
    );
    act(() => renderer.update(menu({ highlightedIndex: 0 })));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
    const row = renderer.root.findByProps({ testID: 'mention-suggestion-ada' });
    expect(row.props.accessibilityState).toEqual({ selected: false });
    expect(
      renderer.root.findByProps({ testID: 'mention-suggestion-channel' }).props.accessibilityState,
    ).toEqual({ selected: true });
  });

  it('scrolls back when the highlight reverses before onScroll reports the new offset', () => {
    scrollTo.mockClear();
    const renderer = render(menu({ highlightedIndex: 0 }));
    act(() => renderer.update(menu({ highlightedIndex: 4 })));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 2 * MENTION_ROW_HEIGHT, animated: false });
    act(() => renderer.update(menu({ highlightedIndex: 0 })));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});
