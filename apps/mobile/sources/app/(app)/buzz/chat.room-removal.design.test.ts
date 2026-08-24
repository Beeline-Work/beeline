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
 * Owner-reported 2026-08-23: deleting a Room succeeded on the relay but the
 * row stayed in the local list forever — delete → navigated out → row
 * persists → tap → navigated out → … The success path must tear the Room out
 * of every local surface before navigating back; a failure must remove
 * nothing.
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

  it('purges the row and records the durable tombstone on the SUCCESS path', () => {
    expect(thenBranch).toContain('markRoomRemovedAndPurge(viewerPubkey, decodedId)');
  });

  it('removes nothing locally when the operation failed', () => {
    const catchBranch = handler.slice(handler.indexOf('.catch('), handler.indexOf('.finally('));
    expect(catchBranch).not.toContain('markRoomRemovedAndPurge');
  });

  it('tears down BEFORE navigating back to the deck', () => {
    expect(thenBranch.indexOf('markRoomRemovedAndPurge')).toBeLessThan(
      thenBranch.indexOf('returnToRoomList'),
    );
  });

  it('guards on an actual viewer identity instead of silently skipping', () => {
    expect(thenBranch).toMatch(/activeViewerPubkey/);
  });
});
