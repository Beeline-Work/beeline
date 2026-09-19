import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bookmarks = readFileSync(new URL('./bookmarks.tsx', import.meta.url), 'utf8');
const channels = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('./chat/_chat-surface.tsx', import.meta.url), 'utf8');
const inspector = readFileSync(
  new URL('../../../components/DesktopRoomInspector.tsx', import.meta.url),
  'utf8',
);
const variants = readFileSync(new URL('./chat/RoomMessageVariants.tsx', import.meta.url), 'utf8');
const ledger = readFileSync(
  new URL('../../../components/buzz/Ledger.tsx', import.meta.url),
  'utf8',
);

describe('private bookmark surfaces', () => {
  it('routes phone bookmarks through the desktop sidebar glyph, not a deck cell', () => {
    // The phone deck's bookmarks cell was retired (R4); the desktop sidebar's
    // workspace-heading glyph is the one bookmarks door.
    expect(channels).not.toContain('bookmarks-cell');
    expect(channels).not.toContain('bookmarkCount');
    const sidebar = readFileSync(
      new URL('../../../components/SidebarView.tsx', import.meta.url),
      'utf8',
    );
    expect(sidebar).toContain('testID="desktop-bookmarks"');
    expect(sidebar).toContain("pathname: '/beeline/bookmarks'");
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

  it('opens a selected desktop bookmark in the shared Room work pane', () => {
    expect(bookmarks).toContain('<DesktopRoomInspector');
    expect(bookmarks).toContain('focusMessageId=');
    expect(bookmarks).not.toContain('styles.preview');
    expect(bookmarks).not.toContain('previewPath');
    expect(bookmarks).not.toContain('previewAuthor');
    expect(bookmarks).not.toContain('previewText');
    expect(bookmarks).not.toContain('OPEN IN {sourceLabel(selected)}');
    expect(inspector).toContain('focusMessageId');
    expect(inspector).toContain('useRoomTranscriptHistory');
    expect(inspector).toContain('desktop-work-focused-message');
  });

  it('does not expose cached content for unavailable sources', () => {
    expect(bookmarks).toContain('Deleted or no longer accessible');
    expect(bookmarks).toContain('This bookmark no longer exposes message content.');
  });
});
