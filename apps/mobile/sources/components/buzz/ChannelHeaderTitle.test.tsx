import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { beelineThemes } from '@/buzz/groknight';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Text: host('Text'), View: host('View') };
});

import { ChannelHeaderTitle } from './ChannelHeaderTitle';

const hull = beelineThemes.obsidian;
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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...(Array.isArray(style) ? style : [style]).filter(Boolean));

describe('ChannelHeaderTitle', () => {
  it('draws a Room as a brass # then the name in the hero role', () => {
    const tree = render(<ChannelHeaderTitle kind="room" title="#beeline" />);
    const title = tree.root.findByProps({ testID: 'chat-title' });
    const sigil = tree.root.findByProps({ testID: 'chat-title-sigil' });
    expect(sigil.props.children).toBe('#');
    expect(flat(sigil.props.style).color).toBe(hull.accent);
    expect(title.props.children[1]).toBe('beeline');
    expect(flat(title.props.style)).toMatchObject({ ...hull.type.hero, color: hull.textPrimary });
    expect(flat(title.props.style).fontFamily).not.toMatch(/Mono/);
  });

  it('draws a DM as a brass @ then the peer', () => {
    const tree = render(<ChannelHeaderTitle kind="dm" title="@alice" />);
    expect(tree.root.findByProps({ testID: 'chat-title-sigil' }).props.children).toBe('@');
    expect(tree.root.findByProps({ testID: 'chat-title' }).props.children[1]).toBe('alice');
  });

  it('sets a corner at body strength, sans, and lets it wrap', () => {
    const tree = render(
      <ChannelHeaderTitle kind="corner" numberOfLines={2} title="#beeline/fix auth" />,
    );
    const title = tree.root.findByProps({ testID: 'chat-title' });
    expect(title.props.numberOfLines).toBe(2);
    expect(flat(title.props.style)).toMatchObject(hull.type.bodyStrong);
    expect(flat(title.props.style).fontFamily).not.toMatch(/Mono/);
  });

  it('shows the placeholder Room with no sigil', () => {
    const tree = render(<ChannelHeaderTitle kind="room" title="Room" />);
    expect(tree.root.findAllByProps({ testID: 'chat-title-sigil' })).toHaveLength(0);
  });
});
