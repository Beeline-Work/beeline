import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source assertions for the Room delete/leave teardown — same technique as
 * `chat.target-branch.design.test.ts`: the chat screen has no render harness
 * of its own (5800+ lines, deep mock surface), so what is pinned is the
 * WIRING, and the behaviour itself is covered by `removed-rooms.test.ts` and
 * `channels.room-removal.test.ts`.
 *
 * Delete is an authoritative kind:9008 relay teardown; leave remains a
 * viewer-local durable dismissal. Both success paths must tear the warm Room
 * row out before navigating back, while a failure removes nothing.
 */
const source = readFileSync(path.join(__dirname, 'chat', '[channelId].tsx'), 'utf8');

function blockFrom(text: string, marker: string, label: string): string {
  const start = text.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${label}`);
}

describe('the Room delete/leave local teardown', () => {
  const handler = blockFrom(
    source,
    'const handleRoomLifecycle = useCallback(',
    'handleRoomLifecycle',
  );
  const thenBranch = handler.slice(handler.indexOf('.then('), handler.indexOf('.catch('));

  it('uses relay deletion for Delete instead of archive-and-retain', () => {
    expect(handler).toContain('transport.deleteRoom(decodedId)');
    expect(handler).not.toContain('transport.archiveRoom(decodedId)');
    expect(handler).not.toContain('remain stored for future recovery');
  });

  it('purges both success paths but tombstones only a viewer leave', () => {
    expect(thenBranch).toContain('useBuzzLocalCache.getState().removeChannel(viewerPubkey, decodedId)');
    expect(thenBranch).toContain('markRoomRemovedAndPurge(viewerPubkey, decodedId)');
    expect(thenBranch).toMatch(/if \(deleting\)[\s\S]*removeChannel[\s\S]*else[\s\S]*markRoomRemovedAndPurge/);
  });

  it('removes nothing locally when the operation failed', () => {
    const catchBranch = handler.slice(handler.indexOf('.catch('), handler.indexOf('.finally('));
    expect(catchBranch).not.toContain('markRoomRemovedAndPurge');
  });

  it('tears down BEFORE navigating back to the deck', () => {
    expect(thenBranch.indexOf('if (deleting)')).toBeLessThan(
      thenBranch.indexOf('returnToRoomList'),
    );
  });

  it('guards on an actual viewer identity instead of silently skipping', () => {
    expect(thenBranch).toMatch(/activeViewerPubkey/);
  });
});
