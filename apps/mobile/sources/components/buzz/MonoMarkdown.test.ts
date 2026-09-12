import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    Pressable: host('Pressable'),
  };
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));

const openExternal = vi.hoisted(() => ({ openExternalUrl: vi.fn(async () => undefined) }));
vi.mock('@/utils/open-external-url', () => openExternal);

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
  it('renders prose as selectable native text', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(MonoMarkdown, { markdown: 'select only these words' }));
    });

    expect(renderedText(renderer)).toContain('select only these words');
    expect(renderer.root.findAll((node) => node.props.selectable === true)).not.toHaveLength(0);
  });

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

  // The transcript's renderItem derives mentionHandles with .filter().map()
  // inside the row builder, so every presence-tick re-invocation hands down a
  // NEW array with EQUAL contents. A plain shallow memo compare fails on that
  // identity churn and rebuilds every row's markdown-to-JSX tree on every
  // tick — the confirmed enter-Room freeze family. The memo comparator must
  // value-compare this one array prop.
  it('still bails when a caller rebuilds an equal mentionHandles array each render', () => {
    const original = (MonoMarkdown as unknown as { type: typeof MonoMarkdown }).type;
    const spy = vi.fn(original);
    (MonoMarkdown as unknown as { type: typeof MonoMarkdown }).type = spy as any;
    try {
      function Parent({ tick }: { tick: number }) {
        void tick;
        return React.createElement(MonoMarkdown, {
          markdown: 'hello **world**',
          mentionHandles: ['lena', 'beebee'],
        });
      }

      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(React.createElement(Parent, { tick: 0 }));
      });
      expect(spy).toHaveBeenCalledTimes(1);

      act(() => {
        renderer.update(React.createElement(Parent, { tick: 1 }));
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      (MonoMarkdown as unknown as { type: typeof MonoMarkdown }).type = original;
    }
  });

  it('re-renders when the handles contents genuinely change', () => {
    const original = (MonoMarkdown as unknown as { type: typeof MonoMarkdown }).type;
    const spy = vi.fn(original);
    (MonoMarkdown as unknown as { type: typeof MonoMarkdown }).type = spy as any;
    try {
      function Parent({ names }: { names: string[] }) {
        return React.createElement(MonoMarkdown, {
          markdown: 'hello **world**',
          mentionHandles: names,
        });
      }

      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(React.createElement(Parent, { names: ['lena'] }));
      });
      expect(spy).toHaveBeenCalledTimes(1);

      act(() => {
        renderer.update(React.createElement(Parent, { names: ['lena', 'beebee'] }));
      });
      expect(spy).toHaveBeenCalledTimes(2);
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

describe('MonoMarkdown renders a resolved mention as a tappable member link', () => {
  it('fires the mention handler with the normalized handle and exposes link semantics', () => {
    const onMention = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(MonoMarkdown, {
          markdown: 'Ask @BeeBee for the result',
          mentionHandles: ['beebee'],
          onMention,
          textStyle: { fontSize: 16 },
        }),
      );
    });

    const mention = renderer.root
      .findAllByType('Text')
      .find((node) => node.props.children === '@BeeBee');
    expect(mention?.props.accessibilityRole).toBe('link');
    act(() => mention?.props.onPress());
    expect(onMention).toHaveBeenCalledWith('beebee');
  });

  it('leaves an unresolved token without a press action', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(MonoMarkdown, {
          markdown: 'Ask @unknown for the result',
          mentionHandles: ['beebee'],
          onMention: vi.fn(),
          textStyle: { fontSize: 16 },
        }),
      );
    });

    const token = renderer.root
      .findAllByType('Text')
      .find((node) => node.props.children === 'Ask @unknown for the result');
    expect(token?.props.onPress).toBeUndefined();
  });
});

// ── URL links route through the shared external URL boundary ────────────────
// The desktop shell hosts the same bundle in a webview where `Linking.openURL`
// does not reach a browser; every transcript link opens through
// `openExternalUrl`, which picks the Tauri opener there and Expo Linking
// everywhere else. Only http(s) is an external destination — a custom scheme
// like `beeline://` stays inert (deep links are routed by the app itself).
describe('MonoMarkdown opens URL links through the shared external URL boundary', () => {
  beforeEach(() => {
    openExternal.openExternalUrl.mockClear();
  });

  it('routes an autolinked http(s) tap to openExternalUrl', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(MonoMarkdown, { markdown: 'see https://example.com now' }),
      );
    });
    const link = renderer.root
      .findAllByType('Text')
      .find((node) => node.props.children === 'https://example.com');
    expect(link?.props.onPress).toBeDefined();
    act(() => link?.props.onPress());
    expect(openExternal.openExternalUrl).toHaveBeenCalledWith('https://example.com');
  });

  it('routes a markdown-link tap with its target URL, not its label', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(MonoMarkdown, { markdown: '[docs](https://docs.example.com/guide)' }),
      );
    });
    const link = renderer.root
      .findAllByType('Text')
      .find((node) => node.props.children === 'docs');
    expect(link?.props.onPress).toBeDefined();
    act(() => link?.props.onPress());
    expect(openExternal.openExternalUrl).toHaveBeenCalledWith('https://docs.example.com/guide');
  });

  it('keeps a non-http custom scheme inert (never handed to the opener)', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(MonoMarkdown, { markdown: '[review](beeline://review/secret)' }),
      );
    });
    const link = renderer.root
      .findAllByType('Text')
      .find((node) => node.props.children === 'review');
    expect(link?.props.onPress).toBeDefined();
    act(() => link?.props.onPress());
    expect(openExternal.openExternalUrl).not.toHaveBeenCalled();
  });
});

// ── Pipe table: an aligned wrapping grid in the machine vocabulary ──────────
import {
  tableColumnWeights,
  TABLE_MIN_COLUMN_WEIGHT,
  TABLE_MAX_COLUMN_WEIGHT,
} from './MonoMarkdown';

describe('tableColumnWeights — one clamped flex weight per column', () => {
  it('weights each column by its longest cell', () => {
    expect(tableColumnWeights([['a', 'bbbbb'], ['ccc', 'b']])).toEqual([3, 5]);
  });

  it('clamps a huge column so it cannot squeeze the rest into slivers', () => {
    expect(tableColumnWeights([['x'.repeat(500), 'ok']])).toEqual([
      TABLE_MAX_COLUMN_WEIGHT,
      TABLE_MIN_COLUMN_WEIGHT,
    ]);
  });

  it('lifts every column to the minimum weight', () => {
    expect(tableColumnWeights([['', ''], ['', '']])).toEqual([
      TABLE_MIN_COLUMN_WEIGHT,
      TABLE_MIN_COLUMN_WEIGHT,
    ]);
  });

  it('reads a ragged row as trailing empty cells', () => {
    expect(tableColumnWeights([['alpha', 'beta'], ['x']])).toEqual([5, 4]);
  });

  it('degrades an empty table to one minimum column', () => {
    expect(tableColumnWeights([])).toEqual([TABLE_MIN_COLUMN_WEIGHT]);
  });
});

describe('MonoMarkdown renders a pipe table as an aligned wrapping grid', () => {
  type JsonNode = {
    type?: string;
    props?: { style?: unknown; children?: unknown };
    children?: unknown;
  };

  function walkJson(node: unknown, visit: (element: JsonNode) => void): void {
    if (Array.isArray(node)) {
      node.forEach((child) => walkJson(child, visit));
      return;
    }
    if (!node || typeof node !== 'object') return;
    visit(node as JsonNode);
    walkJson((node as JsonNode).children, visit);
  }

  function hasType(node: unknown, type: string): boolean {
    let found = false;
    walkJson(node, (element) => {
      if (element.type === type) found = true;
    });
    return found;
  }

  /** The flex weight a grid cell carries in its style (inline, so it survives the mocked sheet). */
  function flexOf(node: JsonNode): number | undefined {
    const styles = Array.isArray(node.props?.style) ? node.props!.style : [node.props?.style];
    for (const style of styles) {
      if (style && typeof style === 'object' && typeof (style as { flex?: unknown }).flex === 'number') {
        return (style as { flex: number }).flex;
      }
    }
    return undefined;
  }

  function isCellView(node: unknown): boolean {
    return (
      !!node &&
      typeof node === 'object' &&
      (node as JsonNode).type === 'View' &&
      flexOf(node as JsonNode) !== undefined
    );
  }

  /** A grid row: a View whose every child is a flex-weighted cell View. */
  function gridRows(node: unknown): JsonNode[][] {
    const rows: JsonNode[][] = [];
    const visit = (element: JsonNode) => {
      const children = Array.isArray(element.children)
        ? element.children
        : element.children
          ? [element.children]
          : [];
      if (children.length > 0 && children.every(isCellView)) rows.push(children as JsonNode[]);
    };
    walkJson(node, visit);
    return rows;
  }

  function render(markdown: string): ReactTestRenderer {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(MonoMarkdown, { markdown, textStyle: { fontSize: 16 } }),
      );
    });
    return renderer;
  }

  const PIPE_TABLE = [
    '| Asset | Consumer | Source |',
    '|---|---|---|',
    '| icon-adaptive.png | Android adaptive launcher icon | generate-monochrome-assets.sh |',
    '| icon-ios.png | iOS home screen | cp icon.png |',
  ].join('\n');

  it('lays every row out as flex-weighted cells sharing one weight per column', () => {
    const rows = gridRows(render(PIPE_TABLE).toJSON());
    expect(rows).toHaveLength(3); // header + two body rows
    for (const row of rows) expect(row).toHaveLength(3);
    for (let column = 0; column < 3; column += 1) {
      const weights = rows.map((row) => flexOf(row[column]!));
      expect(new Set(weights).size).toBe(1); // aligned: one boundary set for the whole table
    }
  });

  it('renders the header first and every cell verbatim, with no flattening join', () => {
    const renderer = render(PIPE_TABLE);
    const rows = gridRows(renderer.toJSON());
    const flatten = (row: JsonNode[]) => row.map((cell) => collectText(cell)).join(' | ');
    expect(flatten(rows[0]!)).toBe('Asset | Consumer | Source');
    expect(flatten(rows[1]!)).toContain('icon-adaptive.png');
    expect(flatten(rows[1]!)).toContain('Android adaptive launcher icon');
    expect(flatten(rows[2]!)).toContain('cp icon.png');
    expect(renderedText(renderer)).not.toContain('  |  ');
  });

  it('keeps the machine text: no horizontal scroll container anywhere in the tree', () => {
    const renderer = render(PIPE_TABLE);
    expect(hasType(renderer.toJSON(), 'ScrollView')).toBe(false);
  });

  it('pads a ragged row so every row shares the same column grid', () => {
    const markdown = [
      '| A | B | C |',
      '|---|---|---|',
      '| one | two |',
      '| three | four | five |',
    ].join('\n');
    const rows = gridRows(render(markdown).toJSON());
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.length === 3)).toBe(true);
  });

  it('renders a header-only table as a single row', () => {
    const rows = gridRows(render('| A | B |\n|---|---|').toJSON());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
  });

  it('renders cell spans as their bare text — machine cells stay machine text', () => {
    const renderer = render('| `npm test` | **ok** |\n|---|---|\n| a | b |');
    const text = renderedText(renderer);
    expect(text).toContain('npm test');
    expect(text).toContain('ok');
    expect(text).not.toContain('`');
    expect(text).not.toContain('**');
  });
});
