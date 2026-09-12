import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('desktop layout mode', () => {
  it('swaps one Room list with the mobile workspace picker in the same column', () => {
    const sidebar = source('components/SidebarView.tsx');
    const channels = source('app/(app)/beeline/channels.tsx');

    expect(sidebar).toContain('<CommunitySwitcherTrigger');
    expect(sidebar).toContain('<CommunityRail');
    expect(sidebar).toContain('communities={workspaces.map(workspaceRailItem)}');
    expect(sidebar).toContain('presentation="column"');
    expect(sidebar).toContain("event.key === 'Escape'");
    expect(sidebar).toContain("document.addEventListener('mousedown', onPointerDown)");
    expect(sidebar).toContain('attention={otherWorkspaceNeedsAttention}');
    expect(sidebar).toContain('pickerTitle={WORKSPACES_LABEL}');
    expect(source('components/buzz/CommunityRail.tsx')).toContain(
      'testID={`workspace-tile-plate-${community.communityId}`}',
    );
    expect(channels).toContain('isDesktop ? (');
    expect(channels).toContain('testID="desktop-room-selection-empty"');
    expect(channels).toContain('!isDesktop && activeCommunityId');
    expect(channels).toContain('!isDesktop && !viewerIsAgent');
  });

  it('groups the desktop index with the mobile section primitive and ordering', () => {
    const sidebar = source('components/SidebarView.tsx');
    const channels = source('app/(app)/beeline/channels.tsx');

    expect(sidebar).toContain('roomListSections(filteredChats)');
    expect(sidebar).toContain("section.kind === 'rooms' ? ROOMS_LABEL : 'Direct messages'");
    expect(sidebar).toContain('<RoomListSectionHeader');
    expect(channels).toContain('<RoomListSectionHeader title={section.title} />');
  });

  it('aligns the desktop Workspace identity with the conversation header', () => {
    const sidebar = source('components/SidebarView.tsx');

    expect(sidebar).toContain('paddingTop: 8');
    expect(sidebar).toContain('paddingBottom: 8');
    expect(sidebar).toContain('safeArea.top + (isDesktop ? 0 : headerHeight)');
  });

  it('removes history chrome only at the desktop layout breakpoint', () => {
    const navigator = source('components/SidebarNavigator.tsx');

    expect(navigator).toContain('const isDesktop = useIsDesktop();');
    expect(navigator).toContain('{!isDesktop && (');
    expect(navigator).not.toContain('COMMUNITY_RAIL_WIDTH');
  });

  it('routes web layout, header, and interaction choices through the live width class', () => {
    const appLayout = source('app/(app)/_layout.tsx');
    const rootLayout = source('app/_layout.tsx');
    const header = source('components/navigation/Header.tsx');
    const bubble = source('components/BubblePressable.tsx');
    const layout = source('components/layout.ts');

    expect(appLayout).toContain("Platform.OS === 'android' || isRunningOnMac() || isDesktop");
    expect(appLayout).not.toContain("isRunningOnMac() || Platform.OS === 'web'");
    expect(rootLayout).toContain('const isDesktop = useIsDesktop();');
    expect(rootLayout).toContain('isDesktop\n              ? { flex: 1 }');
    expect(header).toContain("const isCompact = useLayoutClass() === 'compact';");
    expect(header).not.toMatch(/Platform\.OS === 'web'/);
    expect(bubble).toContain('const isDesktop = useIsDesktop();');
    expect(bubble).not.toContain('Platform');
    expect(layout).not.toContain('Platform');
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
    expect(messages).toContain('style={isDesktop ? styles.replyDesktopMessage : undefined}');
    expect(messages).not.toContain("if (Platform.OS === 'web') {");
    expect(messages).not.toContain('<Text style={styles.replyDesktopLabel}>REPLY</Text>');
    expect(room).toContain('const desktopExperience = isDesktop;');
    expect(room).toContain('const desktopTranscript = isDesktop;');
  });

  it('keeps decorative compose glyph props out of the browser DOM', () => {
    const composeMenu = source('components/buzz/RoomDeckComposeMenu.tsx');
    const identityMark = source('components/buzz/IdentityMark.tsx');

    expect(composeMenu).not.toContain('accessibilityElementsHidden');
    expect(composeMenu).toContain('aria-hidden');
    expect(identityMark).not.toContain('origin="50, 50"');
    expect(identityMark).toContain('transform={`rotate(${rotation * 90} 50 50)`}');
  });
});
