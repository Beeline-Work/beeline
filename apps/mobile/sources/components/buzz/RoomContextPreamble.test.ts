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

describe('RoomContextPreamble', () => {
  it('renders nothing when the corner inherited no Room context', () => {
    expect(render(React.createElement(RoomContextPreamble, { entries: [] })).toJSON()).toBeNull();
  });

  it('quotes the bounded window, attributed, at the ghost tier', () => {
    const renderer = render(
      React.createElement(RoomContextPreamble, {
        entries,
        speakerLabel: (pubkey: string | undefined) => (pubkey === 'a1' ? 'BEEBEE' : 'CAPTAIN'),
      }),
    );
    const rows = renderer.root.findAllByType('Text').slice(1); // [0] is the eyebrow
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
    const rows = renderer.root.findAllByType('Text').slice(1);
    expect(rows[0].props.children).toEqual(['', 'the code blocks are unreadable']);
  });
});
