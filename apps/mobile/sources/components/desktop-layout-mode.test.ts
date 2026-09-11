import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('desktop layout mode', () => {
  it('gives the navigation pane a workspace rail and one Room list', () => {
    const sidebar = source('components/SidebarView.tsx');
    const channels = source('app/(app)/beeline/channels.tsx');

    expect(sidebar).toContain('<CommunityRail');
    expect(sidebar).toContain('communities={workspaces.map(workspaceRailItem)}');
    expect(sidebar).toContain('isDesktop ? (');
    expect(sidebar).toContain('!isDesktop && styles.containerCompact');
    expect(channels).toContain('isDesktop ? (');
    expect(channels).toContain('testID="desktop-room-selection-empty"');
  });

  it('removes history chrome only at the desktop layout breakpoint', () => {
    const navigator = source('components/SidebarNavigator.tsx');

    expect(navigator).toContain('const isDesktop = useIsDesktop();');
    expect(navigator).toContain('{!isDesktop && (');
    expect(navigator).toContain('COMMUNITY_RAIL_WIDTH');
  });

  it('reveals existing message actions on hover or focus without changing compact web', () => {
    const messages = source('app/(app)/beeline/chat/RoomMessageVariants.tsx');
    const room = source('app/(app)/beeline/chat/[channelId].tsx');

    expect(room).toContain('const isDesktop = useIsDesktop();');
    expect(room).toContain('desktopLayout={isDesktop}');
    expect(messages).toContain('onMouseEnter: () => setDesktopActionsVisible(true)');
    expect(messages).toContain('onFocus={() => setDesktopActionsVisible(true)}');
    expect(messages).toContain('testID={`copy-button-${messageId}`}');
    expect(messages).toContain('onPress={onLongPress}');
    expect(messages).toContain("if (Platform.OS === 'web') {");
    expect(messages).toContain('<Text style={styles.replyDesktopLabel}>REPLY</Text>');
  });
});
