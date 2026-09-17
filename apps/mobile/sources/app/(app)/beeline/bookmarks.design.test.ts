import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bookmarks = readFileSync(new URL('./bookmarks.tsx', import.meta.url), 'utf8');
const channels = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('./chat/[channelId].tsx', import.meta.url), 'utf8');
const variants = readFileSync(new URL('./chat/RoomMessageVariants.tsx', import.meta.url), 'utf8');
const ledger = readFileSync(
  new URL('../../../components/buzz/Ledger.tsx', import.meta.url),
  'utf8',
);

describe('private bookmark surfaces', () => {
  it('keeps the navigation cell conditional and above the Room sections', () => {
    expect(channels).toContain('bookmarkCount > 0 && activeCommunityId');
    const header = channels.indexOf('ListHeaderComponent={');
    const cell = channels.indexOf('testID="bookmarks-cell"', header);
    const empty = channels.indexOf('ListEmptyComponent={', cell);
    expect(header).toBeGreaterThanOrEqual(0);
    expect(cell).toBeGreaterThan(header);
    expect(empty).toBeGreaterThan(cell);
  });

  it('offers the toggle in mobile and desktop message actions and marks saved timestamps', () => {
    expect(chat).toContain('testID="message-bookmark-action"');
    expect(variants).toContain('testID={`bookmark-button-${messageId}`}');
    expect(ledger).toContain('testID="chat-bookmark-marker"');
    expect(ledger).toContain('accessibilityLabel="Bookmarked"');
  });

  it('opens the exact original and pages beyond the cached tail', () => {
    expect(bookmarks).toContain('notificationMessageId: bookmark.messageId');
    expect(chat).toContain(
      "if (transcriptHistoryStatus === 'idle') loadOlderTranscriptMessages();",
    );
  });

  it('does not expose cached content for unavailable sources', () => {
    expect(bookmarks).toContain('Deleted or no longer accessible');
    expect(bookmarks).toContain('This bookmark no longer exposes message content.');
  });
});
