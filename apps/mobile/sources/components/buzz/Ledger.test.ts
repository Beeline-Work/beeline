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
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('react-native-reanimated', () => ({
  useReducedMotion: () => false,
}));

import { LedgerEntry, LedgerGhostLine, LedgerMarginalia, LedgerSteer, typewriterFrame } from './Ledger';

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

/** Flattened style objects for every host node of a kind, for "is anything drawn" checks. */
function stylesOfType(renderer: ReactTestRenderer, type: string): Record<string, unknown>[] {
  return renderer.root
    .findAllByType(type)
    .flatMap((node: { props: { style?: unknown } }) =>
      (Array.isArray(node.props.style) ? node.props.style : [node.props.style]).filter(
        (style: unknown): style is Record<string, unknown> => Boolean(style),
      ),
    );
}

describe('the ledger — an agent turn', () => {
  it('can reveal a committed paragraph locally without changing its durable text', () => {
    const paragraph = 'The relay committed this whole paragraph at once.';
    expect(typewriterFrame(paragraph, 0)).toBe('');
    expect(typewriterFrame(paragraph, 9)).toBe('The relay');
    expect(typewriterFrame(paragraph, 999)).toBe(paragraph);
  });

  it('writes a Corner turn as pure flowing prophecy, with no handle at all', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'msg-1',
        luminous: true,
        bodyText: 'Moved the retry into the callback handler.',
        bodyTestID: 'chat-message-text-msg-1',
      }),
    );

    expect(renderer.root.findByProps({ testID: 'chat-message-text-msg-1' })).toBeTruthy();
    // A corner is single-agent: identity lives in the top bar, so no inline
    // handle, no mark, and no ›/· speaker glyph repeats per message.
    expect(renderer.root.findAllByProps({ testID: 'chat-handle-msg-1' })).toHaveLength(0);
    expect(renderer.root.findAllByType('Svg')).toHaveLength(0);
    const text = renderedText(renderer).join(' ');
    expect(text).toContain('Moved the retry into the callback handler.');
    expect(text).not.toMatch(/›|·|—/);
  });

  it('opens a Room voice with its handle inline, on the same line as the words', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'msg-2',
        luminous: true,
        handle: 'Beebee',
        bodyText: 'Read the scheduler and found the stall.',
        bodyTestID: 'body',
      }),
    );

    const handle = renderer.root.findByProps({ testID: 'chat-handle-msg-2' });
    expect(renderedText(renderer).join(' ')).toContain('BEEBEE');

    // The handle is nested inside the paragraph's own Text, not a sibling row —
    // that is what makes it read as one log line, and it is also the shape that
    // avoids the Android "flex Text in a row View" blank-layout bug.
    expect(handle.parent.type).toBe('Text');
    expect(renderedText(renderer).join('')).toContain('Read the scheduler and found the stall.');
    // ...and the paragraph carries the body text as a real string child, so it
    // is never a Text that wraps only other Texts.
    const paragraph = handle.parent;
    expect(paragraph.props.style).not.toMatchObject({ flexDirection: 'row' });
  });

  it('never prints a repeat handle for a continued run', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'msg-3',
        luminous: true,
        continued: true,
        bodyText: 'And rebuilt the index afterwards.',
        bodyTestID: 'body',
      }),
    );
    expect(renderer.root.findAllByProps({ testID: 'chat-handle-msg-3' })).toHaveLength(0);
    expect(renderedText(renderer).join(' ')).toContain('And rebuilt the index afterwards.');
  });

  it('carries no border, fill, radius, or rule on the repeating row', () => {
    for (const handle of [undefined, 'Beebee']) {
      const renderer = render(
        React.createElement(LedgerEntry, {
          itemId: 'msg-1',
          luminous: true,
          handle,
          bodyText: 'A paragraph.',
          bodyTestID: 'body',
        }),
      );
      const row = renderer.root.findByProps({ testID: 'chat-message-msg-1' });
      for (const style of row.props.style.filter(Boolean)) {
        expect(style).not.toHaveProperty('borderWidth');
        expect(style).not.toHaveProperty('borderRadius');
        expect(style).not.toHaveProperty('backgroundColor');
      }
      // No delimiter of any kind between turns: nothing in the row is a rule.
      for (const style of stylesOfType(renderer, 'View')) {
        expect(style.height).not.toBe(1);
        expect(style).not.toHaveProperty('borderTopWidth');
        expect(style).not.toHaveProperty('borderBottomWidth');
      }
    }
  });

  it('renders content near-white without using glow as hierarchy', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'msg-1',
        luminous: true,
        bodyText: 'A paragraph.',
        bodyTestID: 'body',
      }),
    );
    const style = renderer.root.findByProps({ testID: 'body' }).props.textStyle;
    expect(style.color).toBe('#f0f0f3');
    expect(style.textShadowColor).toBeUndefined();
  });

  it('uses a semibold lead sentence and regular Sans body', () => {
    const agent = render(
      React.createElement(LedgerEntry, {
        itemId: 'a',
        luminous: true,
        bodyText: 'Found the cause. The relay closes idle sockets after ninety seconds.',
        bodyTestID: 'lit',
      }),
    );
    const blocks = [
      ...agent.root.findAllByProps({ testID: 'lit-lead' }),
      ...agent.root.findAllByProps({ testID: 'lit' }),
    ];
    const textStyles = blocks.map((block) => block.props.textStyle).filter(Boolean);
    expect(textStyles.map((style) => style.fontFamily)).toContain('IBMPlexSans-SemiBold');
    expect(textStyles.map((style) => style.fontFamily)).toContain('IBMPlexSans-Regular');
    expect(textStyles.every((style) => style.color === '#f0f0f3')).toBe(true);
  });
});

describe('the ledger — a human turn', () => {
  it('identifies your own turn with the sanctioned gold rail and no "YOU" label', () => {
    const agent = render(
      React.createElement(LedgerEntry, {
        itemId: 'a',
        luminous: true,
        bodyText: 'agent prose',
        bodyTestID: 'agent-body',
      }),
    );
    const steer = render(
      React.createElement(LedgerSteer, {
        itemId: 'b',
        bodyText: 'Try the retry path instead.',
        bodyTestID: 'steer-body',
      }),
    );

    const agentStyle = agent.root.findByProps({ testID: 'agent-body' }).props.textStyle;
    const steerStyle = steer.root.findByProps({ testID: 'steer-body' }).props.textStyle;

    expect(steerStyle.fontFamily).toBe(agentStyle.fontFamily);
    expect(steerStyle.fontSize).toBe(agentStyle.fontSize);
    expect(steerStyle.color).toBe('#f0f0f3');
    expect(steerStyle.textShadowColor).toBeUndefined();

    const steerRow = steer.root.findByProps({ testID: 'chat-message-b' });
    const agentRow = agent.root.findByProps({ testID: 'chat-message-a' });
    expect(steerRow.props.style.some((style: Record<string, unknown>) => style?.borderLeftColor === '#c9a24b')).toBe(true);
    expect(agentRow.props.style.some((style: Record<string, unknown>) => style?.borderLeftColor === '#2e2e36')).toBe(true);

    // No caption of any kind survives.
    const text = renderedText(steer).join(' ');
    expect(text).not.toMatch(/\bYOU\b/i);
    expect(text).not.toContain('—');
    expect(steer.root.findAllByProps({ testID: 'chat-steer-by-b' })).toHaveLength(0);
  });

  it('interrupts the ledger with no rule above it', () => {
    const renderer = render(
      React.createElement(LedgerSteer, {
        itemId: 'b',
        bodyText: 'Ship it.',
        bodyTestID: 'steer-body',
      }),
    );
    const block = renderer.root.findByProps({ testID: 'chat-message-b' });
    for (const style of block.props.style.filter(Boolean)) {
      expect(style).not.toHaveProperty('borderWidth');
      expect(style).not.toHaveProperty('borderRadius');
      expect(style).not.toHaveProperty('backgroundColor');
    }
    // The hairline that used to mark a steer is gone: separation is air.
    for (const style of stylesOfType(renderer, 'View')) {
      expect(style.height).not.toBe(1);
      expect(style.backgroundColor).toBeUndefined();
    }
  });

  it('folds a run of your own messages into a single passage', () => {
    const opens = render(
      React.createElement(LedgerSteer, {
        itemId: 'b1',
        bodyText: 'Do the thing.',
        bodyTestID: 'steer-body',
      }),
    );
    const continued = render(
      React.createElement(LedgerSteer, {
        itemId: 'b2',
        continued: true,
        bodyText: 'And rerun the suite.',
        bodyTestID: 'steer-body',
      }),
    );
    const gapOf = (renderer: ReactTestRenderer, id: string) =>
      renderer.root
        .findByProps({ testID: `chat-message-${id}` })
        .props.style.filter(Boolean)
        .reduce((total: number, style: Record<string, number>) => total + (style.marginBottom ?? 0), 0);

    // `marginBottom` is the gap that lands *above* a row: the transcript list
    // is inverted. A continuation keeps flowing; a new run opens a stanza.
    expect(gapOf(continued, 'b2')).toBeLessThan(gapOf(opens, 'b1'));
    expect(renderedText(continued).join(' ')).toContain('And rerun the suite.');
  });

});

describe('the ledger — the right gutter', () => {
  it('hangs the stamp in the margin without touching the flowing column', () => {
    const renderer = render(
      React.createElement(LedgerMarginalia, {
        stamp: '09:41',
        detail: 'npub1abcd…wxyz',
        testID: 'chat-marginalia-msg-1',
      }),
    );
    const gutter = renderer.root
      .findAllByProps({ testID: 'chat-marginalia-msg-1' })
      .find((node: { type: unknown }) => node.type === 'View');
    expect(gutter.props.style.position).toBe('absolute');
    expect(gutter.props.style.right).toBe(0);
    const text = renderedText(renderer).join(' ');
    expect(text).toContain('09:41');
    expect(text).toContain('npub1abcd…wxyz');
  });

  it('renders nothing at all when there is nothing to annotate', () => {
    const renderer = render(React.createElement(LedgerMarginalia, { stamp: '' }));
    expect(renderer.toJSON()).toBeNull();
  });
});

describe('the ledger — machine noise', () => {
  it('folds a wall of tool output into one ghost line, expandable', () => {
    const dump = 'hint: Updates were rejected\nhint: fetch first\nerror: failed to push';
    const renderer = render(
      React.createElement(LedgerGhostLine, {
        label: '3 lines of tool output',
        body: dump,
        testID: 'chat-machine-noise-msg-1',
      }),
    );

    const [summary, affordance] = renderer.root.findAllByType('Text');
    // The summary truncates; the disclosure copy beside it never does — the
    // affordance is the reason the line exists.
    expect(summary.props.numberOfLines).toBe(1);
    expect(affordance.props.numberOfLines).toBeUndefined();
    expect(affordance.props.style.flexShrink).toBe(0);
    expect(renderedText(renderer).join('')).toContain('⋯');
    expect(renderedText(renderer).join('')).toContain('tap to expand');
    // Collapsed means collapsed: the dump is not in the tree at all.
    expect(renderedText(renderer).join('')).not.toContain('failed to push');

    act(() => {
      renderer.root.findByType('Pressable').props.onPress();
    });
    expect(renderedText(renderer).join('')).toContain('failed to push');
    expect(renderedText(renderer).join('')).toContain('tap to collapse');
  });
});
