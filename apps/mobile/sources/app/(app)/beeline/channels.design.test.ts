import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const component = (name: string) =>
  readFileSync(new URL(`../../../components/buzz/${name}.tsx`, import.meta.url), 'utf8');
const row = component('ConversationRow');
const toolbar = component('RoomListToolbar');
describe('Approved Room list layout', () => {
  it('uses the workspace identity and header actions with Members then Tray in the primary row', () => {
    expect(source).toContain('<CommunityDrawerTrigger community={activeCommunity}');
    expect(source).toContain('<MembersAgentsGlyph');
    expect(source).not.toContain('<WorkspaceActionsMenu');
    expect(source).not.toMatch(/<RoomDeckComposeMenu\s+header/);
    expect(source).toContain('actionAccessibilityLabel=');
    expect(source).not.toContain('composeOverlay');
    expect(source).toContain('<TrayGlyph');
    expect(toolbar).not.toContain('<TrayGlyph');
    expect(toolbar).toContain('{actions}');
    expect(toolbar).toContain('{searchOpen && search}');
    expect(toolbar).not.toContain('!desktop && actions');
    expect(toolbar).not.toContain('desktopSearchWrap');
    expect(toolbar).toContain('width: 44');
    expect(toolbar).toContain('height: 44');
  });
  it('renders the approved compact preview, unread title and needs-you treatment', () => {
    expect(row).toContain('numberOfLines={1}');
    // Name/preview/age read the body/meta type roles (DESIGN.md → Type) rather
    // than a bare fontSize/lineHeight — body is 16/23, meta is 13/19.
    expect(row).toContain('name: {\n    ...theme.buzz.type.body,');
    expect(row).toContain('unreadName: { fontFamily: theme.buzz.proseSemibold }');
    expect(row).toContain('preview: {\n    ...theme.buzz.type.meta,');
    expect(row).toContain('age: {\n    ...theme.buzz.type.meta,');
    expect(row).toContain('roomRowAttentionReason');
    expect(row).toContain('needsRing');
    expect(row).toContain('backgroundColor: theme.buzz.accent');
    expect(row).not.toContain('roomRowNeedsAttention');
    expect(row).not.toContain('presenceDot');
  });

  it('retains authorized empty-state actions and a filter recovery action', () => {
    expect(source).toContain('canAddRoom={!viewerIsAgent && canManageWorkspace}');
    expect(source).toContain('canConnectAgent={!viewerIsAgent}');
    expect(source).toContain('<NoMatchingConversationsEmpty');
  });
  it('uses visible conversation counts for the phone toolbar and initial pin filter', () => {
    expect(source).toContain('roomListCounts(chatList?.chats ?? [], pinned)');
    expect(source).toContain('counts={counts}');
    expect(source).toContain(
      '!item.closed && !item.directMessage && pinned.includes(item.room.id)',
    );
  });
});
