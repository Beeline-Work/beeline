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

  it('removes history chrome only at the desktop layout breakpoint', () => {
    const navigator = source('components/SidebarNavigator.tsx');

    expect(navigator).toContain('const isDesktop = useIsDesktop();');
    expect(navigator).toContain('{!isDesktop && (');
    expect(navigator).not.toContain('COMMUNITY_RAIL_WIDTH');
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

  it('keeps decorative compose glyph props out of the browser DOM', () => {
    const composeMenu = source('components/buzz/RoomDeckComposeMenu.tsx');
    const identityMark = source('components/buzz/IdentityMark.tsx');

    expect(composeMenu).not.toContain('accessibilityElementsHidden');
    expect(composeMenu).toContain('aria-hidden');
    expect(identityMark).not.toContain('origin="50, 50"');
    expect(identityMark).toContain('transform={`rotate(${rotation * 90} 50 50)`}');
  });
});
