import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SidebarView.tsx', import.meta.url), 'utf8');
const corners = readFileSync(new URL('./buzz/DesktopRoomCorners.tsx', import.meta.url), 'utf8');

describe('desktop sidebar workspace synchronization', () => {
  it('follows the workspace persisted by a deep-opened Room', () => {
    expect(source).toContain('subscribeActiveCommunityId');
    expect(source).toContain('if (workspaceIdRef.current === nextWorkspaceId) return;');
    expect(source).toContain('setWorkspaceId(nextWorkspaceId);');
    expect(source).toContain('setSurface(null)');
  });

  it('follows the Workspace encoded by browser history and deep links', () => {
    expect(source).toContain('useGlobalSearchParams');
    expect(source).toContain('workspaceIdRef.current = routeWorkspaceId;');
    expect(source).toContain('saveActiveCommunityId(identityPubkey, routeWorkspaceId)');
  });

  it('renders nested corners with the grouped title formatter', () => {
    expect(source).toContain('<DesktopRoomCorners');
    expect(corners).toContain('displayGroupedCornerTitle(');
    expect(corners).toContain('item.room.name,');
  });

  it('spends brass only on waiting nested corner state', () => {
    expect(corners).toContain("corner.state === 'waiting'");
    expect(corners).toContain('cornerDisplayState(corner)');
    expect(corners).toContain('corner.state === \'waiting\' && styles.waiting');
    expect(corners).toContain('waiting: { color: theme.buzz.accent }');
    expect(corners).toContain('state: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet }');
  });

  it('keeps DM presence out of list rows', () => {
    expect(source).not.toContain('directMessagePresence');
    expect(source).not.toContain('presenceCaption');
    expect(source).not.toContain('presenceDot');
    expect(source).not.toContain('desktop-room-presence-');
  });
});
