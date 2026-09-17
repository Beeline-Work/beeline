import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 12, left: 0 }),
}));
vi.mock('./HullDialog', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { HullFloatingSurface: host('HullFloatingSurface'), HullModal: host('HullModal') };
});

import { MESSAGE_REACTION_EMOJIS } from '@beeline/buzz-client';
import { MAX_MESSAGE_REACTIONS, MessageReactionStrip } from './MessageReactionStrip';

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

describe('MessageReactionStrip', () => {
  // The react-native mock renders each composite as a host of the same name,
  // so a node's testID shows up twice in `findAll` — match unique testIDs.
  function renderedTestIDs(renderer: ReactTestRenderer): Set<string> {
    return new Set(
      renderer.root
        .findAll(
          (node: { props?: { testID?: string } }) =>
            typeof node.props?.testID === 'string' &&
            node.props.testID.startsWith('message-reaction-'),
        )
        .map((node: { props: { testID: string } }) => node.props.testID),
    );
  }

  it('is a horizontal scroll of emoji — the whole affordance, no React button', () => {
    const renderer = render(<MessageReactionStrip onReact={() => undefined} />);
    const strip = renderer.root.findByProps({ testID: 'message-reaction-strip' });
    expect(strip.props.horizontal).toBe(true);
    // The emoji are the entry point: plain buttons, nothing that opens them.
    const ids = renderedTestIDs(renderer);
    ids.delete('message-reaction-strip');
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.size).toBeLessThanOrEqual(MAX_MESSAGE_REACTIONS);
    const choices = [...ids].map((testID) => renderer.root.findByProps({ testID }));
    for (const choice of choices) {
      expect(choice.props.accessibilityRole).toBe('button');
    }
    // No React affordance anywhere: no row label, nothing to expand.
    expect(
      renderer.root.findAll(
        (node: { props?: { label?: string } }) => node.props?.label === 'React',
      ),
    ).toEqual([]);
  });

  it('caps the strip at twelve choices', () => {
    expect(MAX_MESSAGE_REACTIONS).toBe(12);
    expect(MESSAGE_REACTION_EMOJIS.length).toBeLessThanOrEqual(MAX_MESSAGE_REACTIONS);
    const renderer = render(<MessageReactionStrip onReact={() => undefined} />);
    const ids = renderedTestIDs(renderer);
    ids.delete('message-reaction-strip');
    expect(ids.size).toBe(Math.min(MESSAGE_REACTION_EMOJIS.length, MAX_MESSAGE_REACTIONS));
  });

  it('hands a pressed emoji to the same react flow, one call per emoji', () => {
    const onReact = vi.fn();
    const renderer = render(<MessageReactionStrip onReact={onReact} />);
    const first = renderer.root.findByProps({
      testID: `message-reaction-${MESSAGE_REACTION_EMOJIS[0]}`,
    });
    act(() => first.props.onPress());
    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onReact).toHaveBeenCalledWith(MESSAGE_REACTION_EMOJIS[0]);
  });
});
