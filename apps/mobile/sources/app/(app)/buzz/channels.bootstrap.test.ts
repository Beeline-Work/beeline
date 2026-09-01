import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');

describe('Room deck bootstrap', () => {
  it('turns a fresh server Workspace response into the first chats request', () => {
    const workspaceApply = source.slice(
      source.indexOf('workspaceRefresh = new SurfaceRefreshScheduler'),
      source.indexOf('workspaceScheduler.current = workspaceRefresh'),
    );
    expect(workspaceApply).toContain('!value.workspaces.some');
    expect(workspaceApply).toContain("pathname: '/buzz/channels'");
    expect(workspaceApply).toContain('communityId: value.workspaces[0].id');
  });

  it('restores the persisted Workspace before choosing server recency order', () => {
    expect(source).toContain('const storedWorkspaceId = await loadActiveCommunityId');
    expect(source).toContain(
      'requestedWorkspaceId ?? storedWorkspaceId ?? cachedWorkspaces?.workspaces[0]?.id',
    );
  });

  it('renders a terminal state when the server returns zero Workspaces', () => {
    const emptyState = source.slice(
      source.indexOf('if (workspaceList?.workspaces.length === 0)'),
      source.indexOf('if (!chatList && !error)'),
    );
    expect(emptyState).toContain('testID="workspace-list-empty"');
    expect(emptyState).toContain('No rooms yet');
    expect(emptyState).toContain('label="CREATE WORKSPACE"');
    expect(emptyState).not.toContain('LOADING ROOMS');
  });

  it('puts add-Room and invite-Agent actions directly on the empty Room deck', () => {
    const emptyDeck = source.slice(
      source.indexOf('ListEmptyComponent='),
      source.indexOf('renderItem='),
    );
    expect(emptyDeck).toContain('testID="empty-add-room"');
    expect(emptyDeck).toContain('setShowCreateRoom(true)');
    expect(emptyDeck).toContain('testID="empty-invite-agent"');
    expect(emptyDeck).toContain("compose('agent')");
  });

  it('refetches an acknowledged Room write without leaving the refreshed deck', () => {
    const createPath = source.slice(
      source.indexOf('const createRoom = useCallback'),
      source.indexOf('const compose = useCallback'),
    );
    expect(createPath).toContain("chatScheduler.current?.force()");
    expect(createPath).not.toContain('openRoom(roomId)');
  });
});
