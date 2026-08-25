import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (obj: any) => obj.android ?? obj.default },
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    View: host('View'),
    ScrollView: host('ScrollView'),
  };
});

import { MonoMarkdown } from './MonoMarkdown';

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

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && 'children' in (node as any)) {
    return collectText((node as any).children);
  }
  return '';
}

function renderedText(node: ReactTestRenderer): string {
  return collectText(node.toJSON());
}

/**
 * The Android bug this suite guards against is a native layout quirk (a
 * flex:1 Text wrapping nested Text inside a flex-row View fails to lay out
 * text on-device, RN issue class "nested Text in flex row Text is blank") —
 * react-test-renderer's JSON tree still contains the text either way, so a
 * plain "is the text present" assertion can't fail against the broken markup.
 * Instead, collect each *top-level* Text node's flattened content (a "View"
 * boundary starts a new group) so we can assert the marker and the item body
 * live in the SAME Text node, which is the actual structural fix.
 */
function topLevelTextGroups(node: unknown): string[] {
  const groups: string[] = [];
  const walk = (n: unknown) => {
    if (n === null || n === undefined || typeof n === 'boolean' || typeof n === 'string') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const el = n as { type?: string; children?: unknown };
    if (el.type === 'Text') {
      groups.push(collectText(el));
      return;
    }
    walk(el.children);
  };
  walk(node);
  return groups;
}

const NUMBERED_LIST_INPUT = `REDESIGN (drill-down, three depths):
1. Transcript = mostly the agent's NATURAL-LANGUAGE updates (what it is doing / found), not raw tool telemetry.
2. Per turn, collapse ALL tool calls + file edits into ONE clickable summary line (e.g. "Edited 4 files, ran tests").
3. Tap that line -> SECONDARY view: the list of edited files + tool calls for that turn.`;

describe('MonoMarkdown lists', () => {
  it('renders numbered list item body text, not just the markers', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown: NUMBERED_LIST_INPUT }));
    });

    const text = renderedText(renderer);
    expect(text).toContain('NATURAL-LANGUAGE updates');
    expect(text).toContain('collapse ALL tool calls');
    expect(text).toContain('SECONDARY view');

    // The actual regression: on the broken markup the marker ("1.") and the
    // item body live in two sibling Text nodes split by a flex-row View, so
    // no single Text node's flattened content contains both.
    const groups = topLevelTextGroups(renderer.toJSON());
    expect(groups.some((g) => g.includes('1.') && g.includes('NATURAL-LANGUAGE'))).toBe(true);
    expect(groups.some((g) => g.includes('2.') && g.includes('collapse ALL tool calls'))).toBe(
      true,
    );
    expect(groups.some((g) => g.includes('3.') && g.includes('SECONDARY view'))).toBe(true);
  });

  it('renders unordered/bullet list item body text', () => {
    const markdown = '- first bullet item text\n- second bullet item text';
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown }));
    });

    const text = renderedText(renderer);
    expect(text).toContain('first bullet item text');
    expect(text).toContain('second bullet item text');

    const groups = topLevelTextGroups(renderer.toJSON());
    expect(groups.some((g) => g.includes('·') && g.includes('first bullet item text'))).toBe(true);
    expect(groups.some((g) => g.includes('·') && g.includes('second bullet item text'))).toBe(true);
  });
});

/**
 * Regression guard for the enter-room/live-update freeze: MonoMarkdown
 * renders once per transcript row inside FlatList's renderItem, which the
 * chat screen recreates on every presence tick (room-enter and live
 * updates). Without memoization every visible row's markdown-to-JSX tree
 * was rebuilt on updates that had nothing to do with that row's own text.
 * A `React.memo`-wrapped component exposes the wrapped function as `.type`;
 * replacing it with a spy directly counts actual invocations (unlike
 * `React.Profiler.onRender`, which fires on every commit that reaches this
 * position regardless of a memo bailout).
 */
describe('MonoMarkdown memoization', () => {
  it('does not re-render when its own props are unchanged', () => {
    const original = (MonoMarkdown as unknown as { type: typeof MonoMarkdown }).type;
    const spy = vi.fn(original);
    (MonoMarkdown as unknown as { type: typeof MonoMarkdown }).type = spy as any;
    try {
      function Parent({ tick }: { tick: number }) {
        void tick;
        return React.createElement(MonoMarkdown, { markdown: 'hello **world**' });
      }

      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(React.createElement(Parent, { tick: 0 }));
      });
      expect(spy).toHaveBeenCalledTimes(1);

      // Parent re-renders with an unrelated prop change; MonoMarkdown's own
      // props are identical, so a memoized component must bail out entirely.
      act(() => {
        renderer.update(React.createElement(Parent, { tick: 1 }));
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      (MonoMarkdown as unknown as { type: typeof MonoMarkdown }).type = original;
    }
  });
});

// ── Brass mention glossing (Speakeasy alignment) ─────────────────────────────
import { glossMentions } from './MonoMarkdown';
import type { MarkdownSpan } from '@/components/markdown/parseMarkdown';

const plain = (text: string): MarkdownSpan => ({ styles: [], text, url: null });

describe('glossMentions — a tagged handle splits into its own span', () => {
  const live = (handle: string) => new Set([handle]);

  it('marks a bare @handle as a mention', () => {
    const spans = glossMentions([plain('ask @beebee about the relay')], live('beebee'));
    expect(spans).toEqual([
      { styles: [], text: 'ask ', url: null },
      { styles: [], text: '@beebee', url: null, mention: true },
      { styles: [], text: ' about the relay', url: null },
    ]);
  });

  it('keeps the whole handle token, including dashes and underscores', () => {
    const spans = glossMentions([plain('@lilac-odd_heron speaks')], live('lilac-odd_heron'));
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ text: '@lilac-odd_heron', mention: true });
  });

  it('glosses a mention at the very start and very end of the text', () => {
    expect(glossMentions([plain('@beebee')], live('beebee'))).toEqual([
      { styles: [], text: '@beebee', url: null, mention: true },
    ]);
    expect(glossMentions([plain('ping @beebee')], live('beebee'))).toEqual([
      { styles: [], text: 'ping ', url: null },
      { styles: [], text: '@beebee', url: null, mention: true },
    ]);
  });

  it('never glosses inside an email address', () => {
    expect(glossMentions([plain('mail user@example.com today')], live('example'))).toEqual([
      plain('mail user@example.com today'),
    ]);
  });

  it('never glosses inside code spans or links — machine text is not an address', () => {
    const code = glossMentions(
      [{ styles: ['code'], text: 'run @deploy now', url: null }],
      live('deploy'),
    );
    expect(code).toEqual([{ styles: ['code'], text: 'run @deploy now', url: null }]);
    const link = glossMentions(
      [{ styles: [], text: 'see @beebee', url: 'https://x.dev' }],
      live('beebee'),
    );
    expect(link).toEqual([{ styles: [], text: 'see @beebee', url: 'https://x.dev' }]);
  });

  it('passes untouched prose through unchanged (same object)', () => {
    const span = plain('no mentions here');
    expect(glossMentions([span])).toEqual([span]);
  });

  it('keeps an unresolved @token ordinary instead of showing a false live mention', () => {
    const span = plain('ask @unknown about the relay');
    expect(glossMentions([span], live('alan'))).toEqual([span]);
  });
});

// ── Explicit #room / #room/corner references ────────────────────────────────
import { glossChannelReferences } from './MonoMarkdown';
import { buildChannelReferenceIndex } from '@/buzz/channel-reference';

const channelIndex = buildChannelReferenceIndex(
  [
    { channelId: 'room-roadmap', name: 'Roadmap' },
    { channelId: 'room-infra', name: 'infra' },
  ],
  [{ channelId: 'corner-deploy', parentChannelId: 'room-infra', name: 'deploy-watch' }],
);

describe('glossChannelReferences — a resolved reference splits into its own span', () => {
  it('tags a known room reference and leaves the rest of the prose intact', () => {
    const spans = glossChannelReferences([plain('move this to #Roadmap please')], channelIndex);
    expect(spans).toEqual([
      { styles: [], text: 'move this to ', url: null },
      {
        styles: [],
        text: '#Roadmap',
        url: null,
        channelRef: { kind: 'room', channelId: 'room-roadmap' },
      },
      { styles: [], text: ' please', url: null },
    ]);
  });

  it('tags a known corner reference with its full target', () => {
    const spans = glossChannelReferences([plain('#infra/deploy-watch is green')], channelIndex);
    expect(spans).toEqual([
      {
        styles: [],
        text: '#infra/deploy-watch',
        url: null,
        channelRef: { kind: 'corner', channelId: 'corner-deploy', parentChannelId: 'room-infra' },
      },
      { styles: [], text: ' is green', url: null },
    ]);
  });

  it('keeps unknown tokens ordinary', () => {
    const span = plain('no such #nowhere place');
    expect(glossChannelReferences([span], channelIndex)).toEqual([span]);
  });

  it('returns the same spans untouched when no index is supplied', () => {
    const span = plain('#Roadmap');
    expect(glossChannelReferences([span], undefined)).toEqual([span]);
  });

  it('never glosses inside code spans, URLs, or an existing mention', () => {
    const code = glossChannelReferences(
      [{ styles: ['code'], text: '#Roadmap', url: null }],
      channelIndex,
    );
    expect(code).toEqual([{ styles: ['code'], text: '#Roadmap', url: null }]);
    const link = glossChannelReferences(
      [{ styles: [], text: 'see #Roadmap', url: 'https://x.dev/#Roadmap' }],
      channelIndex,
    );
    expect(link).toEqual([{ styles: [], text: 'see #Roadmap', url: 'https://x.dev/#Roadmap' }]);
    const mention = glossChannelReferences(
      [{ styles: [], text: '@beebee in #Roadmap', url: null, mention: true }],
      channelIndex,
    );
    expect(mention[0]).toMatchObject({ mention: true });
    expect(mention).toHaveLength(1);
  });
});

describe('MonoMarkdown renders a recognized reference as one tappable internal link', () => {
  const onPress = vi.fn();
  type TextNode = { props: { onPress?: () => void; children?: unknown }; children?: unknown[] };

  function render(markdown: string) {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(MonoMarkdown, {
          markdown,
          channelIndex,
          onChannelReference: onPress,
          textStyle: { fontSize: 16 },
        }),
      );
    });
    return renderer;
  }

  function textNodes(renderer: ReactTestRenderer): TextNode[] {
    const nodes: TextNode[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const el = node as { type?: string; props?: TextNode['props']; children?: unknown };
      if (el.type === 'Text') nodes.push(el as TextNode);
      walk(el.children);
    };
    walk(renderer.toJSON());
    return nodes;
  }

  it('fires onChannelReference with the exact target for a room tap', () => {
    onPress.mockClear();
    const renderer = render('head to #Roadmap now');
    const tappable = textNodes(renderer).find((node) => node.props.onPress);
    expect(tappable).toBeTruthy();
    act(() => tappable!.props.onPress!());
    expect(onPress).toHaveBeenCalledWith({ kind: 'room', channelId: 'room-roadmap' }, '#Roadmap');
  });

  it('fires onChannelReference with the exact corner target and parent', () => {
    onPress.mockClear();
    const renderer = render('check #infra/deploy-watch');
    const tappable = textNodes(renderer).find((node) => node.props.onPress);
    act(() => tappable!.props.onPress!());
    expect(onPress).toHaveBeenCalledWith(
      { kind: 'corner', channelId: 'corner-deploy', parentChannelId: 'room-infra' },
      '#infra/deploy-watch',
    );
  });

  it('attaches no press handler for unknown or unresolvable tokens', () => {
    onPress.mockClear();
    const renderer = render('#nowhere and #infra/unknown stay plain');
    expect(textNodes(renderer).filter((node) => node.props.onPress)).toHaveLength(0);
    expect(renderedText(renderer)).toContain('#nowhere and #infra/unknown stay plain');
  });

  it('preserves authored content byte-for-byte across the whole message', () => {
    onPress.mockClear();
    const markdown = 'go **#Roadmap** then `#infra` then https://x.dev and #infra/deploy-watch!';
    const renderer = render(markdown);
    // Every character survives; only spans gained press handlers.
    expect(renderedText(renderer)).toBe(markdown.replace(/\*\*|`/g, ''));
    // Three tappable spans: URL link, bold room reference, corner reference.
    // The inline-code `#infra` stays inert.
    const tappable = textNodes(renderer).filter((node) => node.props.onPress);
    expect(tappable).toHaveLength(3);
    act(() => tappable[0]!.props.onPress!());
    expect(onPress).toHaveBeenCalledWith({ kind: 'room', channelId: 'room-roadmap' }, '#Roadmap');
    onPress.mockClear();
    act(() => tappable[2]!.props.onPress!());
    expect(onPress).toHaveBeenCalledWith(
      { kind: 'corner', channelId: 'corner-deploy', parentChannelId: 'room-infra' },
      '#infra/deploy-watch',
    );
  });

  it('renders multiple valid references in one message', () => {
    onPress.mockClear();
    const renderer = render('#Roadmap then #infra/deploy-watch then #Roadmap again');
    const tappable = textNodes(renderer).filter((node) => node.props.onPress);
    expect(tappable).toHaveLength(3);
  });
});
