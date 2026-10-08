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

const SCROLL_CALL = /\.\s*(scrollToIndex|scrollToOffset|scrollToEnd|scrollIntoView|scrollTo)\s*\(/;
const SCROLL_TOP_WRITE = /\.\s*scrollTop\s*(\+|-)?=(?!=)/;

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
      return readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          SCROLL_CALL.test(line) || SCROLL_TOP_WRITE.test(line) ? [`${relative}:${index + 1}`] : [],
        );
    });
    expect(offenders).toEqual([]);
  });

  it('catches a feature that scrolls the list itself', () => {
    expect(
      SCROLL_CALL.test('flatListRef.current?.scrollToIndex({ index, viewPosition: 1 });'),
    ).toBe(true);
    expect(SCROLL_CALL.test('flatListRef.current?.scrollToOffset({ offset: 0 })')).toBe(true);
    expect(SCROLL_CALL.test('transcriptRef.current?.scrollToEnd({ animated: false })')).toBe(true);
    expect(SCROLL_CALL.test("row?.scrollIntoView({ block: 'center' })")).toBe(true);
    expect(SCROLL_TOP_WRITE.test('node.scrollTop = node.scrollHeight;')).toBe(true);
    expect(SCROLL_TOP_WRITE.test('node.scrollTop += delta;')).toBe(true);
    expect(SCROLL_TOP_WRITE.test('if (node.scrollTop <= 50) loadOlder();')).toBe(false);
    expect(SCROLL_TOP_WRITE.test('node.scrollTop === 0')).toBe(false);
    expect(SCROLL_CALL.test('// `scrollToIndex` fails until the row is measured')).toBe(false);
  });
});
