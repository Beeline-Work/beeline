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

import { LedgerAttribution, LedgerEntry, LedgerSteer } from './Ledger';

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

/** A stand-in for the faceted identity mark a Room passes as attribution. */
const mark = () => React.createElement('Svg', { testID: 'agent-mark' });

describe('the ledger — an agent turn', () => {
  it('writes a Corner turn as plain text, with no per-message identity at all', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'msg-1',
        bodyText: 'Moved the retry into the callback handler.',
        bodyTestID: 'chat-message-text-msg-1',
      }),
    );

    expect(renderer.root.findByProps({ testID: 'chat-message-text-msg-1' })).toBeTruthy();
    // A corner is single-agent: the identity lives in the top bar, so no mark,
    // no uppercase name label, and no ›/· speaker glyph repeats per message.
    expect(renderer.root.findAllByType('Svg')).toHaveLength(0);
    const text = renderedText(renderer).join(' ');
    expect(text).toContain('Moved the retry into the callback handler.');
    expect(text).not.toMatch(/›|·|—/);
    expect(renderer.root.findAllByProps({ testID: 'chat-steer-by-msg-1' })).toHaveLength(0);
  });

  it('keeps a Room agent identifiable in the flow, by mark and name', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'msg-2',
        bodyText: 'Read the scheduler and found the stall.',
        bodyTestID: 'body',
        attribution: React.createElement(LedgerAttribution, {
          mark: mark(),
          name: 'Beebee',
          testID: 'chat-attribution-msg-2',
        }),
      }),
    );

    expect(renderer.root.findByProps({ testID: 'chat-attribution-msg-2' })).toBeTruthy();
    expect(renderer.root.findAllByType('Svg')).toHaveLength(1);
    // Uppercase mono, so the name reads as a machine label rather than prose.
    expect(renderedText(renderer).join(' ')).toContain('BEEBEE');
  });

  it('carries no border, fill, or radius on the repeating row, either way', () => {
    for (const attribution of [
      undefined,
      React.createElement(LedgerAttribution, { mark: mark(), name: 'Beebee' }),
    ]) {
      const renderer = render(
        React.createElement(LedgerEntry, {
          itemId: 'msg-1',
          bodyText: 'A paragraph.',
          bodyTestID: 'body',
          attribution,
        }),
      );
      const row = renderer.root.findByProps({ testID: 'chat-message-msg-1' });
      expect(row.props.style).not.toHaveProperty('borderWidth');
      expect(row.props.style).not.toHaveProperty('borderRadius');
      expect(row.props.style).not.toHaveProperty('backgroundColor');
    }
  });

  it('reads as lit against the obsidian — a symmetric halo, no hue, no offset', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'msg-1',
        bodyText: 'A paragraph.',
        bodyTestID: 'body',
      }),
    );
    const style = renderer.root.findByProps({ testID: 'body' }).props.textStyle;
    expect(style.textShadowColor).toMatch(/^rgba\(228, 228, 228,/);
    expect(style.textShadowOffset).toEqual({ width: 0, height: 0 });
    expect(style.textShadowRadius).toBeGreaterThan(0);
  });
});

describe('the ledger — a human turn', () => {
  it('emphasises a steer against the agent’s flowing text', () => {
    const agent = render(
      React.createElement(LedgerEntry, {
        itemId: 'a',
        bodyText: 'agent prose',
        bodyTestID: 'agent-body',
      }),
    );
    const steer = render(
      React.createElement(LedgerSteer, {
        itemId: 'b',
        signature: 'YOU',
        bodyText: 'Try the retry path instead.',
        bodyTestID: 'steer-body',
      }),
    );

    const agentStyle = agent.root.findByProps({ testID: 'agent-body' }).props.textStyle;
    const steerStyle = steer.root.findByProps({ testID: 'steer-body' }).props.textStyle;

    // Heavier and larger than the ledger it interrupts — but never brighter:
    // the agent's output stays the luminous layer.
    expect(steerStyle.fontSize).toBeGreaterThan(agentStyle.fontSize);
    expect(steerStyle.fontFamily).not.toBe(agentStyle.fontFamily);
    expect(steerStyle.textShadowColor).toBeUndefined();

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
      React.createElement(LedgerSteer, {
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

  it('names a Room steer before its words, and carries the author’s npub', () => {
    // Display names are not unique, and in a Room the name has to arrive
    // before the text for a fast scroll to work — so the trailing signature
    // gives way to a leading attribution rather than doubling up with it.
    const renderer = render(
      React.createElement(LedgerSteer, {
        itemId: 'b',
        signature: 'ALEX',
        bodyText: 'Ship it.',
        bodyTestID: 'steer-body',
        attribution: React.createElement(LedgerAttribution, {
          mark: mark(),
          name: 'Alex',
          detail: 'npub1abcd…wxyz',
        }),
      }),
    );
    const text = renderedText(renderer).join(' ');
    expect(text).toContain('ALEX');
    expect(text).toContain('npub1abcd…wxyz');
    expect(text).not.toContain('—');
    expect(renderer.root.findAllByProps({ testID: 'chat-steer-by-b' })).toHaveLength(0);
  });

  it('folds a run of one person’s messages into a single block', () => {
    const continued = render(
      React.createElement(LedgerSteer, {
        itemId: 'b2',
        signature: 'ALEX',
        continued: true,
        bodyText: 'And rerun the suite.',
        bodyTestID: 'steer-body',
      }),
    );
    // No second rule and no second name: the block above already carries both.
    const rule = continued.root
      .findAllByType('View')
      .map((node: { props: { style?: Record<string, unknown> } }) => node.props.style)
      .find((style?: Record<string, unknown>) => style?.height === 1);
    expect(rule).toBeUndefined();
    expect(continued.root.findAllByProps({ testID: 'chat-steer-by-b2' })).toHaveLength(0);
    expect(renderedText(continued).join(' ')).toContain('And rerun the suite.');
  });

  it('still carries the offline delivery note', () => {
    const renderer = render(
      React.createElement(LedgerSteer, {
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
      React.createElement(LedgerSteer, {
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

    const rule = renderer.root
      .findAllByType('View')
      .map((node: { props: { style?: Record<string, unknown> } }) => node.props.style)
      .find((style?: Record<string, unknown>) => style?.height === 1);
    expect(rule?.backgroundColor).toBeTruthy();
  });
});
