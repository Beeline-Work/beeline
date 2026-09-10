import { describe, expect, it } from 'vitest';
import { desktopRoomWorkLine } from '../buzz/desktop-workbench-state';

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
