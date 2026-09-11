import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { desktopRoomWorkLine } from '../buzz/desktop-workbench-state';

const source = readFileSync(new URL('./SidebarView.tsx', import.meta.url), 'utf8');

const item = (overrides: Record<string, unknown> = {}) =>
  ({
    room: { id: 'r', workspaceId: 'w', name: 'Room', archived: false, createdAt: 1, updatedAt: 1 },
    memberCount: 2,
    cornerCount: 0,
    unread: false,
    ...overrides,
  }) as any;

describe('desktop Room attention copy', () => {
  it('shows only truthful relevant work state', () => {
    expect(desktopRoomWorkLine(item())).toBeNull();
    expect(desktopRoomWorkLine(item({ agentState: 'working' }))).toBe('Agent thinking');
    expect(desktopRoomWorkLine(item({ agentState: 'needs-you', cornerCount: 2 }))).toBe(
      'Needs your attention',
    );
    expect(desktopRoomWorkLine(item({ cornerCount: 1 }))).toBe('1 active Corner');
  });
});

describe('desktop sidebar workspace synchronization', () => {
  it('follows the workspace persisted by a deep-opened Room', () => {
    expect(source).toContain('subscribeActiveCommunityId');
    expect(source).toContain('if (workspaceIdRef.current === nextWorkspaceId) return;');
    expect(source).toContain('setWorkspaceId(nextWorkspaceId);');
    expect(source).toContain('setSurface(null)');
  });
});
