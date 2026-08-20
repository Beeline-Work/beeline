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
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
  };
});

import { groknight } from '@/buzz/groknight';
import { RoomContextPreamble } from './RoomContextPreamble';

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

const entries = [
  { id: 'a', text: 'the code blocks are unreadable', timestamp: 1, pubkey: 'p1', isAgent: false },
  { id: 'b', text: 'I can colour them', timestamp: 2, pubkey: 'a1', isAgent: true },
];

/**
 * The flat string of one labelled Text. Read from `props.children` (the raw
 * JSX children array) rather than serialised — `JSON.stringify` on a rendered
 * node walks into the circular Fiber graph. See the mobile-test note in
 * AGENTS.md.
 */
function summaryText(renderer: ReactTestRenderer, suffix: string): string {
  const node = renderer.root
    .findAllByType('Text')
    .find((candidate: { props: { testID?: string } }) => candidate.props.testID?.endsWith(suffix));
  const children = node?.props.children;
  return (Array.isArray(children) ? children : [children])
    .filter((part: unknown) => typeof part === 'string' || typeof part === 'number')
    .join('');
}

/** Open the disclosure the way a reader does. */
function expand(renderer: ReactTestRenderer): void {
  const trigger = renderer.root.findByType('Pressable');
  act(() => trigger.props.onPress());
}

describe('RoomContextPreamble', () => {
  it('renders nothing when the corner inherited no Room context', () => {
    expect(render(React.createElement(RoomContextPreamble, { entries: [] })).toJSON()).toBeNull();
  });

  it('opens collapsed, so a fresh corner does not lead with a dump of the Room', () => {
    // A corner opened mid-conversation has almost no transcript of its own, so
    // an expanded ten-line quote was the entire first screen — the reader
    // arrived at their new corner and met an undigested replay of what they
    // had just said, with the objective nowhere in sight.
    const renderer = render(React.createElement(RoomContextPreamble, { entries }));
    const quoted = renderer.root
      .findAllByType('Text')
      .filter((node: { props: { testID?: string } }) =>
        node.props.testID?.endsWith('-entry'),
      );
    expect(quoted).toHaveLength(0);
    expect(summaryText(renderer, '-summary')).toBe('⋯ 2 earlier messages from the Room');
    expect(summaryText(renderer, '-affordance')).toContain('tap to expand');
  });

  it('says "message" for one and "messages" for more', () => {
    const one = render(
      React.createElement(RoomContextPreamble, { entries: [entries[0]] }),
    );
    expect(summaryText(one, '-summary')).toBe('⋯ 1 earlier message from the Room');
  });

  it('quotes the bounded window, attributed, at the ghost tier, once expanded', () => {
    const renderer = render(
      React.createElement(RoomContextPreamble, {
        entries,
        speakerLabel: (pubkey: string | undefined) => (pubkey === 'a1' ? 'BEEBEE' : 'CAPTAIN'),
      }),
    );
    expand(renderer);
    const rows = renderer.root
      .findAllByType('Text')
      .filter((node: { props: { testID?: string } }) => node.props.testID?.endsWith('-entry'));
    expect(rows).toHaveLength(2);
    expect(rows[0].props.children).toEqual(['CAPTAIN  ', 'the code blocks are unreadable']);
    expect(rows[1].props.children).toEqual(['BEEBEE  ', 'I can colour them']);
    // Dimmer than anything the corner itself says, so scrolling up reads as
    // leaving the corner rather than as more of it.
    for (const row of rows) expect(row.props.style.color).toBe(groknight.ledgerGhost);
    // A reminder of a discussion, not a second transcript.
    for (const row of rows) expect(row.props.numberOfLines).toBe(3);
  });

  it('drops the attribution rather than inventing one when the speaker is unknown', () => {
    const renderer = render(React.createElement(RoomContextPreamble, { entries }));
    expand(renderer);
    const rows = renderer.root
      .findAllByType('Text')
      .filter((node: { props: { testID?: string } }) => node.props.testID?.endsWith('-entry'));
    expect(rows[0].props.children).toEqual(['', 'the code blocks are unreadable']);
  });

  it('collapses again on a second tap', () => {
    const renderer = render(React.createElement(RoomContextPreamble, { entries }));
    expand(renderer);
    expand(renderer);
    const rows = renderer.root
      .findAllByType('Text')
      .filter((node: { props: { testID?: string } }) => node.props.testID?.endsWith('-entry'));
    expect(rows).toHaveLength(0);
  });
});
