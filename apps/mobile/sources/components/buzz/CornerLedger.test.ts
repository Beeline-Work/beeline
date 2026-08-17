import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

import { CornerLedgerEntry, CornerSteer } from './CornerLedger';

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

/** Every string the tree renders, flattened, so "is this label present" is answerable. */
function renderedText(renderer: ReactTestRenderer): string[] {
  const strings: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return strings;
}

describe('corner ledger — the agent', () => {
  it('renders an agent turn as plain text, with no per-message identity at all', () => {
    const renderer = render(
      React.createElement(CornerLedgerEntry, {
        itemId: 'msg-1',
        bodyText: 'Moved the retry into the callback handler.',
        bodyTestID: 'chat-message-text-msg-1',
      }),
    );

    expect(renderer.root.findByProps({ testID: 'chat-message-text-msg-1' })).toBeTruthy();
    // A corner is single-agent: the identity lives in the top bar, so no avatar,
    // no uppercase name label, and no ›/· speaker glyph repeats per message.
    expect(renderer.root.findAllByType('Svg')).toHaveLength(0);
    const text = renderedText(renderer).join(' ');
    expect(text).toContain('Moved the retry into the callback handler.');
    expect(text).not.toMatch(/›|·|—/);
    expect(renderer.root.findAllByProps({ testID: 'chat-steer-by-msg-1' })).toHaveLength(0);
  });

  it('carries no border, fill, or radius on the repeating row', () => {
    const renderer = render(
      React.createElement(CornerLedgerEntry, {
        itemId: 'msg-1',
        bodyText: 'A paragraph.',
        bodyTestID: 'body',
      }),
    );
    const row = renderer.root.findByProps({ testID: 'chat-message-msg-1' });
    expect(row.props.style).not.toHaveProperty('borderWidth');
    expect(row.props.style).not.toHaveProperty('borderRadius');
    expect(row.props.style).not.toHaveProperty('backgroundColor');
  });
});

describe('corner ledger — the human', () => {
  it('emphasises a steer against the agent’s flowing text', () => {
    const agent = render(
      React.createElement(CornerLedgerEntry, {
        itemId: 'a',
        bodyText: 'agent prose',
        bodyTestID: 'agent-body',
      }),
    );
    const steer = render(
      React.createElement(CornerSteer, {
        itemId: 'b',
        signature: 'YOU',
        bodyText: 'Try the retry path instead.',
        bodyTestID: 'steer-body',
      }),
    );

    const agentStyle = agent.root.findByProps({ testID: 'agent-body' }).props.textStyle;
    const steerStyle = steer.root.findByProps({ testID: 'steer-body' }).props.textStyle;

    // Brighter, heavier, and larger than the ledger it interrupts.
    expect(steerStyle.color).not.toBe(agentStyle.color);
    expect(steerStyle.fontSize).toBeGreaterThan(agentStyle.fontSize);
    expect(steerStyle.fontWeight ?? steerStyle.fontFamily).not.toBe(
      agentStyle.fontWeight ?? agentStyle.fontFamily,
    );

    // ...and pulled out of the ledger column, at a width that does not depend
    // on intrinsic sizing (MonoMarkdown's own root is width: '100%').
    const inset = steer.root
      .findAllByType('View')
      .map((node: { props: { style?: Record<string, unknown> } }) => node.props.style)
      .find((style?: Record<string, unknown>) => style?.alignSelf === 'flex-end');
    expect(inset?.width).toBe('82%');
  });

  it('names who steered with a signature instead of a per-message avatar', () => {
    const renderer = render(
      React.createElement(CornerSteer, {
        itemId: 'b',
        signature: 'ALEX',
        bodyText: 'Ship it.',
        bodyTestID: 'steer-body',
      }),
    );
    expect(renderedText(renderer).join('')).toContain('— ALEX');
    expect(renderer.root.findByProps({ testID: 'chat-steer-by-b' })).toBeTruthy();
    expect(renderer.root.findAllByType('Svg')).toHaveLength(0);
  });

  it('still carries the offline delivery note', () => {
    const renderer = render(
      React.createElement(CornerSteer, {
        itemId: 'b',
        signature: 'YOU',
        bodyText: 'Ship it.',
        bodyTestID: 'steer-body',
        offlineQueued: true,
      }),
    );
    expect(renderedText(renderer).join(' ')).toContain('AGENT OFFLINE');
  });

  it('uses no box either — the interruption is one hairline rule', () => {
    const renderer = render(
      React.createElement(CornerSteer, {
        itemId: 'b',
        signature: 'YOU',
        bodyText: 'Ship it.',
        bodyTestID: 'steer-body',
      }),
    );
    const block = renderer.root.findByProps({ testID: 'chat-message-b' });
    expect(block.props.style).not.toHaveProperty('borderWidth');
    expect(block.props.style).not.toHaveProperty('borderRadius');
    expect(block.props.style).not.toHaveProperty('backgroundColor');
  });
});
