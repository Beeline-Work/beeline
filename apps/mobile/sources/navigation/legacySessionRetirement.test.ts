import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('legacy session retirement', () => {
  it('does not register stale session and new-session compatibility routes', () => {
    expect(existsSync(new URL('../app/(app)/session/[...legacy].tsx', import.meta.url))).toBe(
      false,
    );
    expect(existsSync(new URL('../app/(app)/new/index.tsx', import.meta.url))).toBe(false);

    const layout = source('app/(app)/_layout.tsx');
    expect(layout).not.toContain('name="session/[...legacy]"');
    expect(layout).not.toContain('name="session/[id]"');
    expect(layout).not.toContain('session/[id]/info');
  });

  it('does not retain stale session notification compatibility routing', () => {
    const rootLayout = source('app/_layout.tsx');
    const routing = source('utils/notificationRouting.ts');
    expect(rootLayout).not.toContain('isLegacySessionNotificationResponse');
    expect(rootLayout).not.toContain('Retired session notification');
    expect(routing).not.toContain('isLegacySessionNotificationData');
    expect(rootLayout).not.toContain('navigateToSession');
  });

  it('uses the server-indexed Beeline Room list in the persistent sidebar', () => {
    const sidebar = source('components/SidebarView.tsx');
    expect(sidebar).toContain('RoomViewClient');
    expect(sidebar).toContain('http.chats(workspaceId)');
    expect(sidebar).toContain('surface.chats.map');
    expect(sidebar).toContain('router.push(`/beeline/chat/${encodeURIComponent(item.room.id)}`');
    expect(sidebar).not.toMatch(/MainView|SessionsList|ActiveSessionsGroupCompact/);
    expect(sidebar).not.toContain("router.push('/settings')");
    expect(sidebar).not.toContain("router.navigate('/new')");
  });

  it('removes legacy session destinations from the command palette', () => {
    const palette = source('components/CommandPalette/CommandPaletteProvider.tsx');
    expect(palette).toContain("router.navigate('/beeline/channels')");
    expect(palette).toContain("router.push('/beeline/settings')");
    expect(palette).not.toMatch(/navigateToSession|Recent Sessions|\/session\//);
    expect(palette).not.toContain("router.navigate('/new')");
    expect(palette).not.toContain("router.push('/settings')");
  });
});
