import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SidebarView.tsx', import.meta.url), 'utf8');

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
    expect(source).toContain('displayGroupedCornerTitle(');
    expect(source).not.toContain('{corner.corner.name}\n                                </Text>');
  });
});
