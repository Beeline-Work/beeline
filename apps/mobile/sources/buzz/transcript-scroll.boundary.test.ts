import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = path.join(__dirname, '..');

/** The scroll controller moves the transcript list. Nothing else calls a list's scroll methods. */
const ALLOWED = new Set([
  'buzz/transcript-scroll-controller.ts',
  // Not the Room transcript: the command palette's own result list.
  'components/CommandPalette/CommandPaletteResults.tsx',
  // Not the Room transcript: the desktop work pane's corner preview, its own FlatList.
  'components/DesktopRoomInspector.tsx',
  // Not the Room transcript: the tag menu's own scroll view.
  'components/buzz/MentionSuggestionMenu.tsx',
]);

const SCROLL_METHODS = 'scrollToIndex|scrollToOffset|scrollToEnd|scrollIntoView|scrollTo';

/**
 * Any reach for a list's scroll method or `scrollTop`, not only a plain
 * call: optional (`?.`) or bracket access, a call split across lines, a
 * method taken off the list or destructured from it, and every write to
 * `scrollTop`. `\s` spans newlines because each pattern runs over the whole
 * file, so formatting cannot hide a call.
 */
const SCROLL_REACHES = [
  new RegExp(String.raw`(?:\?\.|\.)\s*(?:${SCROLL_METHODS})\b`, 'g'),
  new RegExp(String.raw`\[\s*['"\x60](?:${SCROLL_METHODS}|scrollTop)['"\x60]\s*\]`, 'g'),
  new RegExp(String.raw`\{[^{}]*\b(?:${SCROLL_METHODS})\b[^{}]*\}\s*=[^=>]`, 'g'),
  /(?:\?\.|\.)\s*scrollTop\s*(?:[-+*/]|\?\?|\|\||&&)?=(?!=)/g,
];

/** 1-based lines where `source` reaches for a list's scroll methods. */
function scrollReaches(source: string): number[] {
  const lines = new Set<number>();
  for (const pattern of SCROLL_REACHES) {
    for (const match of source.matchAll(pattern)) {
      lines.add(source.slice(0, match.index).split('\n').length);
    }
  }
  return [...lines].sort((left, right) => left - right);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === 'vendor' ? [] : sourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [full];
  });
}

describe('Transcript scroll boundary', () => {
  it('lets only the scroll controller move the transcript list', () => {
    const offenders = sourceFiles(sources).flatMap((file) => {
      const relative = path.relative(sources, file).split(path.sep).join('/');
      if (ALLOWED.has(relative)) return [];
      return scrollReaches(readFileSync(file, 'utf8')).map((line) => `${relative}:${line}`);
    });
    expect(offenders).toEqual([]);
  });

  it.each([
    ['a plain call', 'flatListRef.current?.scrollToIndex({ index, viewPosition: 1 });'],
    ['an optional call', 'list.scrollToOffset?.({ offset: 0 });'],
    ['an optional member', 'flatListRef.current?.scrollToEnd({ animated: false });'],
    ['a call split across lines', "row\n  ?.scrollIntoView\n  ({ block: 'center' });"],
    ['a member on its own line', 'flatListRef.current\n  ?.\n  scrollToOffset({ offset: 0 });'],
    ['bracket access', "list['scrollToOffset']({ offset: 0 });"],
    ['bracket access with a template key', 'list[`scrollToIndex`]?.({ index: 0 });'],
    ['a method taken off the list', 'const move = list.scrollToOffset;\nmove({ offset: 0 });'],
    ['a method bound off the list', 'const move = list.scrollToIndex.bind(list);'],
    ['a destructured method', 'const { scrollToOffset } = flatListRef.current!;'],
    ['a destructured method across lines', 'const {\n  scrollToEnd,\n} = list;'],
    ['window.scrollTo', 'window.scrollTo(0, 0);'],
    ['a scrollTop write', 'node.scrollTop = node.scrollHeight;'],
    ['a scrollTop write across lines', 'node\n  .scrollTop =\n  node.scrollHeight;'],
    ['a compound scrollTop write', 'node.scrollTop += delta;'],
    ['a bracket scrollTop write', "node['scrollTop'] = 0;"],
    ['an optional-chain scrollTop write', 'node!.scrollTop -= 10;'],
  ])('catches %s', (_shape, source) => {
    expect(scrollReaches(source)).not.toEqual([]);
  });

  it('reports the line of the scroll member', () => {
    expect(
      scrollReaches('const a = 1;\nconst b = 2;\nlist\n  .scrollToOffset({ offset: 0 });'),
    ).toEqual([4]);
  });

  it.each([
    ['a scrollTop read', 'if (node.scrollTop <= 50) loadOlder();'],
    ['a scrollTop comparison', 'node.scrollTop === 0'],
    ['a prose mention', '// `scrollToIndex` fails until the row is measured'],
    ['the failure callback prop', 'onScrollToIndexFailed={phoneScrollList.scrollToIndexFailed}'],
    ['a controller request', "scrollController.request({ kind: 'newest' });"],
    ['an object with a scroll-named key', 'const props = { scrollTo: target };'],
  ])('leaves %s alone', (_shape, source) => {
    expect(scrollReaches(source)).toEqual([]);
  });
});
