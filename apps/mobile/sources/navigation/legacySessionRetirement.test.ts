import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('legacy session retirement', () => {
    it('redirects stale session and new-session links to the Room list', () => {
        expect(source('app/(app)/session/[...legacy].tsx')).toContain(
            '<Redirect href="/buzz/channels" />',
        );
        expect(source('app/(app)/new/index.tsx')).toContain(
            '<Redirect href="/buzz/channels" />',
        );

        const layout = source('app/(app)/_layout.tsx');
        expect(layout).toContain('name="session/[...legacy]"');
        expect(layout).not.toContain('name="session/[id]"');
        expect(layout).not.toContain('session/[id]/info');
    });

    it('sends stale session notification taps to the Room list', () => {
        const rootLayout = source('app/_layout.tsx');
        expect(rootLayout).toContain('isLegacySessionNotificationResponse(response)');
        expect(rootLayout).toContain("router.replace('/buzz/channels')");
        expect(rootLayout).not.toContain('navigateToSession');
    });

    it('uses the cached Beeline Room list in the persistent sidebar', () => {
        const sidebar = source('components/SidebarView.tsx');
        expect(sidebar).toContain('selectChannelList');
        expect(sidebar).toContain('roomListSections');
        expect(sidebar).toContain("router.push(`/buzz/chat/${encodeURIComponent(item.id)}`");
        expect(sidebar).not.toMatch(/MainView|SessionsList|ActiveSessionsGroupCompact/);
        expect(sidebar).not.toContain("router.push('/settings')");
        expect(sidebar).not.toContain("router.navigate('/new')");
    });

    it('removes legacy session destinations from the command palette', () => {
        const palette = source('components/CommandPalette/CommandPaletteProvider.tsx');
        expect(palette).toContain("router.navigate('/buzz/channels')");
        expect(palette).toContain("router.push('/buzz/settings')");
        expect(palette).not.toMatch(/navigateToSession|Recent Sessions|\/session\//);
        expect(palette).not.toContain("router.navigate('/new')");
        expect(palette).not.toContain("router.push('/settings')");
    });
});
