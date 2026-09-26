import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bookmarks = readFileSync(new URL('./tray.tsx', import.meta.url), 'utf8');
const cell = readFileSync(
  new URL('../../../components/buzz/NeedsYouCell.tsx', import.meta.url),
  'utf8',
);
const channels = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const toolbar = readFileSync(
  new URL('../../../components/buzz/RoomListToolbar.tsx', import.meta.url),
  'utf8',
);
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

describe('the tray: Needs you and Saved', () => {
  it('opens the tray from the conversation toolbar, badged only while something needs you', () => {
    expect(channels).not.toContain('bookmarks-cell');
    expect(channels).not.toContain('bookmarkCount');
    expect(channels).toContain('<RoomListToolbar');
    expect(toolbar).toContain("testID={desktop ? 'desktop-tray' : 'workspace-tray'}");
    expect(toolbar).toContain('<TrayGlyph');
    expect(toolbar).toContain('needsYouCount > 0 ? (');
    expect(toolbar).toContain('compactNeedsYouCount(needsYouCount)');
    expect(channels).toContain("pathname: '/beeline/tray'");
    const sidebar = readFileSync(
      new URL('../../../components/SidebarView.tsx', import.meta.url),
      'utf8',
    );
    expect(sidebar).toContain('<RoomListToolbar');
    expect(sidebar).toContain("pathname: '/beeline/tray'");
  });

  it('offers the toggle in mobile and desktop message actions and marks saved timestamps', () => {
    expect(chat).toContain('testID="message-bookmark-action"');
    expect(variants).toContain('testID={`bookmark-button-${messageId}`}');
    expect(ledger).toContain('testID="chat-bookmark-marker"');
    expect(ledger).toContain('accessibilityLabel="Bookmarked"');
  });

  it('opens the exact original and pages beyond the cached tail', () => {
    expect(bookmarks).toContain('notificationMessageId: target.messageId');
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

  it('names both section counts in the header without a PRIVATE label', () => {
    expect(bookmarks).toContain('trailing={`${needs.length} NEED YOU · ${bookmarks.length} SAVED`}');
    expect(bookmarks).toContain('eyebrow={workspaceName');
    expect(bookmarks).not.toContain('PRIVATE');
  });

  it('parts the drawn corner mark from the title with a spacing step', () => {
    expect(bookmarks).toContain('<CornerGlyph');
    expect(bookmarks).toContain('size={CORNER_META_SIZE}');
    expect(bookmarks).toContain('gap: 8');
    expect(bookmarks).toContain('styles.originSigil');
    expect(bookmarks).toContain('originSigil: { ...theme.buzz.type.meta, color: brand.mark }');
    expect(bookmarks).not.toContain('originDiamond');
    expect(bookmarks).not.toContain("'◇'");
  });

  it('does not expose cached content for unavailable sources', () => {
    expect(bookmarks).toContain('Deleted or no longer accessible');
    expect(bookmarks).toContain('This bookmark no longer exposes message content.');
  });

  it('draws Needs-you cells as plain equal rows: no tag, no dot, no type label', () => {
    expect(cell).toContain('{item.text}');
    expect(cell).not.toContain('author');
    expect(cell).not.toContain('statusMark');
    expect(cell).toContain('renderLeftActions');
    expect(cell).toContain('onHoverIn');
    expect(cell).toContain('DISMISS');
  });
});
