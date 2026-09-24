import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');
const component = (name: string) =>
  readFileSync(new URL(`../../../components/buzz/${name}.tsx`, import.meta.url), 'utf8');
const row = component('ConversationRow');
const toolbar = component('RoomListToolbar');
describe('Approved Room list layout', () => {
  it('retains the virtualized mobile list, Messages grouping and real Room navigation', () => {
    expect(source).toContain('<SectionList');
    expect(source).toContain('sections={chatSections}');
    expect(source).toContain('<RoomListSectionHeader title={section.title}');
    expect(source).toContain('openRoom(item.room.id)');
  });
  it('uses the workspace identity and header actions with bookmarks beside search', () => {
    expect(source).toContain('<CommunityDrawerTrigger community={activeCommunity}');
    expect(source).toContain('<WorkspaceActionsMenu');
    expect(source).toMatch(/<RoomDeckComposeMenu\s+header/);
    expect(source).not.toContain('composeOverlay');
    expect(toolbar).toContain('<BookmarksGlyph');
    expect(toolbar).toContain('width: 44');
    expect(toolbar).toContain('height: 44');
  });
  it('renders readable previews and separate unread emphasis in both themes', () => {
    expect(row).toMatch(/numberOfLines=\{2\}/);
    expect(row).toContain('...theme.buzz.type.body');
    expect(row).toContain('theme.buzz.type.bodyStrong.fontFamily');
    expect(row).toContain('item.unread &&');
    expect(row).toContain('backgroundColor: theme.buzz.accent');
    expect(row).not.toContain('roomRowNeedsAttention');
    expect(row).not.toContain('presenceDot');
  });
  it('never passes desktop selection to mobile and sends corner taps to the existing list', () => {
    expect(source).not.toContain('selected={');
    expect(source).toContain("pathname: '/beeline/corners/[roomId]'");
    expect(source).toContain('params: { roomId: item.room.id }');
    expect(source).not.toContain('<DesktopRoomCorners');
  });
  it('keeps desktop corners independently selectable, waiting first, and excludes archived work', () => {
    const corners = component('DesktopRoomCorners');
    expect(corners).toContain("corner.state !== 'archived'");
    expect(corners).toContain("Number(b.state === 'waiting') - Number(a.state === 'waiting')");
    expect(corners).toContain('onOpen(corner.corner.id)');
    expect(corners).toContain('cornerDisplayState(corner)');
    expect(corners).toContain('renderDrag(');
  });
  it('retains authorized empty-state actions and a filter recovery action', () => {
    expect(source).toContain('canAddRoom={!viewerIsAgent && canManageWorkspace}');
    expect(source).toContain('canConnectAgent={!viewerIsAgent}');
    expect(source).toContain('label="SHOW ALL"');
  });
});
