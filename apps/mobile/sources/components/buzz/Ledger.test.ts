import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  LedgerEntry,
  LedgerGhostLine,
  LedgerMarginalia,
  LedgerRoomUpdate,
  LedgerSteer,
  typewriterFrame,
} from './Ledger';
import { markMessageRevealed, resetMessageReveals } from '@/buzz/message-reveal';

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
afterEach(() => resetMessageReveals());

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
  it('renders a Room update as one italic caption with mono gutter time and a plain digest', () => {
    const renderer = render(
      React.createElement(LedgerRoomUpdate, {
        id: 'merged',
        line: '⌗ merged → main @ 12345678',
        stamp: '16:41',
        digest: 'Added derived relay updates and regression coverage.',
      }),
    );

    const line = renderer.root.findByProps({ testID: 'room-update-line-merged' });
    const stamp = renderer.root.findByProps({ testID: 'room-update-stamp-merged' });
    const digest = renderer.root.findByProps({ testID: 'room-update-digest-merged' });
    expect(line.props.style).toMatchObject({
      fontFamily: 'SpaceGrotesk-Regular',
      fontStyle: 'italic',
      fontSize: 12,
      color: '#83838d',
    });
    expect(stamp.props.style.fontFamily).toBe('IBMPlexMono-Regular');
    expect(digest.props.style).toMatchObject({
      fontFamily: 'SpaceGrotesk-Regular',
      fontSize: 13,
      marginLeft: 18,
    });
    expect(digest.props.style.fontStyle).toBeUndefined();
  });

  it('can reveal a committed paragraph locally without changing its durable text', () => {
    const paragraph = 'The relay committed this whole paragraph at once.';
    expect(typewriterFrame(paragraph, 0)).toBe('');
    expect(typewriterFrame(paragraph, 9)).toBe('The relay');
    expect(typewriterFrame(paragraph, 999)).toBe(paragraph);
  });

  it('emphasizes the lead by weight and brightness at ONE size, never by size', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'a',
        luminous: true,
        byline: { name: 'Ox', role: 'agent', stamp: '16:41' },
        bodyText: 'Found the cause. The relay closes idle sockets after ninety seconds.',
        bodyTestID: 'lit',
      }),
    );

    const leadStyle = renderer.root.findByProps({ testID: 'lit-lead' }).props.textStyle;
    const bodyStyle = renderer.root.findByProps({ testID: 'lit' }).props.textStyle;

    // Weight carries hierarchy: medium lead, regular body.
    expect(leadStyle.fontFamily).toBe('SpaceGrotesk-Medium');
    expect(bodyStyle.fontFamily).toBe('SpaceGrotesk-Regular');
    // Brightness carries it too: primary lead, secondary body.
    expect(leadStyle.color).toBe('#f0f0f3');
    expect(bodyStyle.color).toBe('#c9c9d1');
    // ONE size — this is the load-bearing rule.
    expect(leadStyle.fontSize).toBe(bodyStyle.fontSize);
    expect(leadStyle.lineHeight).toBe(bodyStyle.lineHeight);
    expect(leadStyle.fontSize).toBe(16);
  });

  it('opens a Room run with a byline: steel dot, name, role tag, stamp', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'msg-2',
        luminous: true,
        byline: { name: 'Beebee', role: 'agent', stamp: '09:41' },
        bodyText: 'Read the scheduler and found the stall.',
        bodyTestID: 'body',
      }),
    );

    const text = renderedText(renderer).join('');
    expect(text).toContain('Beebee');
    expect(text).toContain('agent · ');
    expect(text).toContain('09:41');

    // The dot defaults to steel for everyone but the viewer.
    const dots = stylesOfType(renderer, 'View').filter((style) => style.width === 5);
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.every((style) => style.backgroundColor !== '#b08a4a')).toBe(true);
  });

  it('never prints a repeat byline for a continued run', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'msg-3',
        luminous: true,
        continued: true,
        bodyText: 'And rebuilt the index afterwards.',
        bodyTestID: 'body',
      }),
    );
    expect(renderedText(renderer).join(' ')).not.toContain('·');
    expect(renderedText(renderer).join(' ')).toContain('And rebuilt the index afterwards.');
  });

  it('separates turns with a hairline divider, and continuations flow with none', () => {
    const opens = render(
      React.createElement(LedgerEntry, {
        itemId: 'a',
        luminous: true,
        bodyText: 'A paragraph.',
        bodyTestID: 'body',
      }),
    );
    const opensRow = opens.root
      .findByProps({ testID: 'chat-message-a' })
      .props.style.filter(Boolean);
    expect(opensRow.some((style: Record<string, unknown>) => style.borderBottomWidth === 1)).toBe(
      true,
    );

    const continued = render(
      React.createElement(LedgerEntry, {
        itemId: 'b',
        luminous: true,
        continued: true,
        bodyText: 'Another.',
        bodyTestID: 'body',
      }),
    );
    const continuedRow = continued.root
      .findByProps({ testID: 'chat-message-b' })
      .props.style.filter(Boolean);
    expect(continuedRow.every((style: Record<string, unknown>) => !style.borderBottomWidth)).toBe(
      true,
    );

    // Still boxless: no frame, no fill, no radius on the repeating row.
    for (const style of [...opensRow, ...continuedRow]) {
      expect(style).not.toHaveProperty('borderRadius');
      expect(style).not.toHaveProperty('backgroundColor');
      expect(style).not.toHaveProperty('borderLeftWidth');
      expect(style).not.toHaveProperty('borderTopWidth');
    }
  });
});

describe('the ledger — a human turn is plain body text', () => {
  it('renders your message at body weight and size — NEVER the bolded lead', () => {
    // The explicit captain correction: an earlier mockup auto-bolded user
    // messages into headlines. The only thing marking your turn as yours is
    // the brass byline; the text itself is exactly the agent BODY treatment.
    const steer = render(
      React.createElement(LedgerSteer, {
        itemId: 'me',
        byline: { name: 'You', stamp: '16:22', isViewer: true },
        bodyText: '@ox open a corner for this fix',
        bodyTestID: 'mine',
      }),
    );

    // No lead block exists at all — not even one that happens to match a
    // sentence shape.
    expect(steer.root.findAllByProps({ testID: 'mine-lead' })).toHaveLength(0);
    const style = steer.root.findByProps({ testID: 'mine' }).props.textStyle;
    expect(style.fontFamily).toBe('SpaceGrotesk-Regular');
    expect(style.fontSize).toBe(16);
    expect(style.color).toBe('#f0f0f3');
  });

  it('matches a long agent turn’s body size next to it, so neither reads bigger', () => {
    const agent = render(
      React.createElement(LedgerEntry, {
        itemId: 'a',
        luminous: true,
        byline: { name: 'Ox', role: 'agent', stamp: '16:41' },
        bodyText:
          'The beeline command breaks after every self-update. When a daemon updates itself it replaces the launcher symlink.',
        bodyTestID: 'agent-body',
      }),
    );
    const steer = render(
      React.createElement(LedgerSteer, {
        itemId: 'b',
        byline: { name: 'You', stamp: '16:44', isViewer: true },
        bodyText: 'nice. fix it.',
        bodyTestID: 'steer-body',
      }),
    );

    const agentBody = agent.root.findByProps({ testID: 'agent-body' }).props.textStyle;
    const steerBody = steer.root.findByProps({ testID: 'steer-body' }).props.textStyle;
    expect(steerBody.fontFamily).toBe(agentBody.fontFamily);
    expect(steerBody.fontSize).toBe(agentBody.fontSize);
    expect(steerBody.lineHeight).toBe(agentBody.lineHeight);
  });

  it('marks your own turn with the brass dot and brass name alone', () => {
    const steer = render(
      React.createElement(LedgerSteer, {
        itemId: 'b',
        byline: { name: 'You', stamp: '16:22', isViewer: true },
        bodyText: 'Try the retry path instead.',
        bodyTestID: 'steer-body',
      }),
    );

    // The dot style is an array ([steel base, brass override]); merge each
    // candidate's fragments before judging the resolved background.
    const dotNodes = steer.root.findAllByType('View').filter((node) => {
      const merged = Object.assign(
        {},
        ...(Array.isArray(node.props.style) ? node.props.style : [node.props.style ?? {}]),
      ) as Record<string, unknown>;
      return merged.width === 5;
    });
    expect(dotNodes.length).toBeGreaterThan(0);
    for (const node of dotNodes) {
      const merged = Object.assign(
        {},
        ...(Array.isArray(node.props.style) ? node.props.style : [node.props.style ?? {}]),
      ) as Record<string, unknown>;
      expect(merged.backgroundColor).toBe('#b08a4a');
    }

    // No caption of any kind survives beyond the byline itself.
    const row = steer.root.findByProps({ testID: 'chat-message-b' }).props.style.filter(Boolean);
    expect(row.every((style: Record<string, unknown>) => !style.borderLeftWidth)).toBe(true);
    expect(steer.root.findAllByProps({ testID: 'chat-steer-by-b' })).toHaveLength(0);
  });

  it('keeps resolved and unresolved mention messages at the same text size and weight', () => {
    // In the reported sequence the resolved @codex message opened the captain's
    // speaker run, while the immediately-following unresolved @ox message was
    // classified as a continuation. Routing metadata never reaches LedgerSteer;
    // run position must not make otherwise-identical human prose look different.
    const resolved = render(
      React.createElement(LedgerSteer, {
        itemId: 'resolved',
        byline: { name: 'You', stamp: '10:00', isViewer: true },
        bodyText: '@codex can you see this message',
        bodyTestID: 'resolved-body',
      }),
    );
    const unresolved = render(
      React.createElement(LedgerSteer, {
        itemId: 'unresolved',
        continued: true,
        bodyText: '@ox can you see this message',
        bodyTestID: 'unresolved-body',
      }),
    );

    const resolvedStyle = resolved.root.findByProps({
      testID: 'resolved-body',
    }).props.textStyle;
    const unresolvedStyle = unresolved.root.findByProps({
      testID: 'unresolved-body',
    }).props.textStyle;
    expect(unresolvedStyle).toMatchObject({
      fontFamily: resolvedStyle.fontFamily,
      fontSize: resolvedStyle.fontSize,
      lineHeight: resolvedStyle.lineHeight,
    });
  });

  it('folds a run of your own messages into a single passage', () => {
    const opens = render(
      React.createElement(LedgerSteer, {
        itemId: 'b1',
        byline: { name: 'You', stamp: '10:00', isViewer: true },
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
        .reduce(
          (total: number, style: Record<string, number>) => total + (style.marginBottom ?? 0),
          0,
        );

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
  it('takes the quiet left-rule mono treatment, clearly not conversation', () => {
    const dump = 'hint: Updates were rejected\nhint: fetch first\nerror: failed to push';
    const renderer = render(
      React.createElement(LedgerGhostLine, {
        label: '3 lines of tool output',
        body: dump,
        testID: 'chat-machine-noise-msg-1',
      }),
    );

    const host = renderer.root
      .findAllByProps({ testID: 'chat-machine-noise-msg-1' })
      .find((node: { type: unknown }) => typeof node.type === 'string');
    const block = host.props.style;
    expect(block.borderLeftWidth).toBe(2);
    expect(block.paddingLeft).toBe(13);

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

describe('the ledger — the typewriter reveals each message at most once', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // `luminous` + a lead sentence: the lead renders immediately, the body is
  // what the typewriter reveals — the exact shape the chat screen mounts for
  // a new agent turn with `item.isNew` set.
  const typeOut = (itemId: string) =>
    React.createElement(LedgerEntry, {
      itemId,
      luminous: true,
      bodyText: 'Found the cause. The relay closes idle sockets after ninety seconds.',
      bodyTestID: 'body',
      typewriter: true,
    });

  const treeText = (renderer: ReactTestRenderer) => renderedText(renderer).join('');

  it('types a genuinely new message out once, then never again on remount', () => {
    const first = render(typeOut('msg-1'));
    // The reveal has not run yet: only the lead sentence is on the slab.
    expect(treeText(first)).toContain('Found the cause.');
    expect(treeText(first)).not.toContain('closes idle sockets');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(treeText(first)).toContain('closes idle sockets');
    act(() => first.unmount());

    // FlatList recycling the row / re-entering the Room: same id, already
    // revealed this session — full prose immediately, no second type-out.
    const second = render(typeOut('msg-1'));
    expect(treeText(second)).toContain('closes idle sockets');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(treeText(second)).toContain('closes idle sockets');
  });

  it('shows an already-revealed message in full from the first frame', () => {
    // The warm-revalidation re-stamp path: the id was revealed earlier in the
    // session, then the room re-opened and `isNew` came back on the message.
    markMessageRevealed('msg-2');
    const renderer = render(typeOut('msg-2'));
    expect(treeText(renderer)).toContain('closes idle sockets');
  });

  it('still gives a different message its own type-out', () => {
    const first = render(typeOut('msg-3'));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    act(() => first.unmount());

    const second = render(typeOut('msg-4'));
    expect(treeText(second)).not.toContain('closes idle sockets');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(treeText(second)).toContain('closes idle sockets');
  });

  it('a row without the typewriter renders in full and spends nothing', () => {
    const plain = React.createElement(LedgerEntry, {
      itemId: 'msg-5',
      luminous: true,
      bodyText: 'Found the cause. The relay closes idle sockets after ninety seconds.',
      bodyTestID: 'body',
      typewriter: false,
    });
    const renderer = render(plain);
    expect(treeText(renderer)).toContain('closes idle sockets');
    act(() => renderer.unmount());

    // Nothing was marked, so a later typewriter mount still gets its reveal —
    // the gate is spent only by a mount that actually revealed the prose.
    const later = render(typeOut('msg-5'));
    expect(treeText(later)).not.toContain('closes idle sockets');
  });
});

// ── Per-speaker identity marks ───────────────────────────────────────────────
//
// The byline's leading indicator is the speaker's EXISTING identity mark
// (`buzz/identity-mark.ts`) at transcript scale — no new vocabulary. The real
// SVG renderer is covered by `IdentityMark.test.ts`; here it is stubbed so the
// attribution contract (who gets which mark, and when none renders) is what is
// under test.
vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  const IdentityMarkStub = (props: Record<string, unknown>) =>
    ReactModule.createElement('IdentityMark', props, props.children as never);
  return { IdentityMark: IdentityMarkStub };
});

describe('the ledger — per-speaker identity marks', () => {
  const markOf = (renderer: ReactTestRenderer): Record<string, any> =>
    renderer.root.findByProps({ testID: 'chat-byline-mark' }).props;

  it('leads an agent turn with that agent’s own identity mark, ring while working', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'm1',
        luminous: true,
        byline: {
          name: 'Beebee',
          role: 'agent',
          stamp: '09:41',
          mark: { seed: 'agent-pubkey-a', kind: 'agent', alive: true },
        },
        bodyText: 'Read the scheduler and found the stall.',
        bodyTestID: 'body',
      }),
    );

    const mark = markOf(renderer);
    expect(mark.seed).toBe('agent-pubkey-a');
    expect(mark.kind).toBe('agent');
    expect(mark.alive).toBe(true);
    // Transcript scale, inside the brief's ~16–18px band.
    expect(mark.size).toBe(17);
    // The mark REPLACES the generic dot — both never render together.
    const dots = stylesOfType(renderer, 'View').filter((style) => style.width === 5);
    expect(dots.length).toBe(0);
  });

  it('renders the same mark shape without the ring when the agent is idle', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'm2',
        luminous: true,
        byline: {
          name: 'Beebee',
          role: 'agent',
          stamp: '09:45',
          mark: { seed: 'agent-pubkey-a', kind: 'agent', alive: false },
        },
        bodyText: 'Done for now.',
        bodyTestID: 'body',
      }),
    );

    const mark = markOf(renderer);
    expect(mark.kind).toBe('agent');
    expect(mark.alive).toBe(false);
  });

  it('leads a human turn with that person’s circle mark, never an alive ring', () => {
    const renderer = render(
      React.createElement(LedgerSteer, {
        itemId: 'm3',
        byline: {
          name: 'You',
          stamp: '10:00',
          isViewer: true,
          mark: { seed: 'viewer-pubkey', kind: 'human' },
        },
        bodyText: 'Ship it.',
        bodyTestID: 'body',
      }),
    );

    const mark = markOf(renderer);
    expect(mark.seed).toBe('viewer-pubkey');
    expect(mark.kind).toBe('human');
    // Gold means a live agent, by type: a human mark never carries `alive`.
    expect(mark.alive).toBeUndefined();
  });

  it('gives two speakers visibly different marks from the same system', () => {
    const first = render(
      React.createElement(LedgerEntry, {
        itemId: 'm4',
        luminous: true,
        byline: {
          name: 'Beebee',
          role: 'agent',
          stamp: '09:41',
          mark: { seed: 'agent-pubkey-a', kind: 'agent' },
        },
        bodyText: 'First voice.',
        bodyTestID: 'body',
      }),
    );
    const second = render(
      React.createElement(LedgerSteer, {
        itemId: 'm5',
        byline: {
          name: 'Mika',
          stamp: '09:42',
          mark: { seed: 'person-pubkey-b', kind: 'human' },
        },
        bodyText: 'Second voice.',
        bodyTestID: 'body',
      }),
    );

    const agentMark = markOf(first);
    const personMark = markOf(second);
    // Distinct seeds → the deterministic per-identity palette/fill diverge;
    // distinct kinds → triangle vs circle. Both from the ONE mark system.
    expect(agentMark.seed).not.toBe(personMark.seed);
    expect(agentMark.kind).toBe('agent');
    expect(personMark.kind).toBe('human');
    expect(agentMark.size).toBe(personMark.size);
  });

  it('renders no mark on a continued run — the byline (and mark) open the run only', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'm6',
        continued: true,
        byline: undefined,
        bodyText: 'Still the same voice flowing on.',
        bodyTestID: 'body',
      }),
    );

    expect(renderer.root.findAllByProps({ testID: 'chat-byline-mark' })).toHaveLength(0);
  });

  it('keeps the plain dot fallback for a byline without a mark', () => {
    const renderer = render(
      React.createElement(LedgerEntry, {
        itemId: 'm7',
        luminous: true,
        byline: { name: 'Beebee', role: 'agent', stamp: '09:41' },
        bodyText: 'No mark provided.',
        bodyTestID: 'body',
      }),
    );

    expect(renderer.root.findAllByProps({ testID: 'chat-byline-mark' })).toHaveLength(0);
    const dots = stylesOfType(renderer, 'View').filter((style) => style.width === 5);
    expect(dots.length).toBeGreaterThan(0);
  });
});
