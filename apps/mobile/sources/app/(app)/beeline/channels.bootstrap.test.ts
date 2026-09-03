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
    expect(workspaceApply).toContain("pathname: '/beeline/channels'");
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
    expect(emptyState).toContain('No Rooms yet');
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
    // Sentence-case labels; the tracked-uppercase MonoButton pair is gone.
    expect(emptyDeck).toContain('Start a Room</Text>');
    expect(emptyDeck).toContain('Invite an agent</Text>');
    expect(emptyDeck).not.toContain('label="ADD ROOM"');
    expect(emptyDeck).not.toContain('label="INVITE AGENT"');
    expect(emptyDeck).not.toContain('<MonoButton');
  });

  it('refetches an acknowledged Room write without leaving the refreshed deck', () => {
    const createPath = source.slice(
      source.indexOf('const createRoom = useCallback'),
      source.indexOf('const compose = useCallback'),
    );
    expect(createPath).toContain('chatScheduler.current?.force()');
    expect(createPath).not.toContain('openRoom(roomId)');
  });

  it('opens #welcome once per identity before the stored Workspace is read', () => {
    const landing = source.slice(
      source.indexOf('claimFirstLaunchLanding(nextIdentity.publicKey)'),
      source.indexOf('const storedWorkspaceId = await loadActiveCommunityId'),
    );
    expect(landing).toContain('saveActiveCommunityId(nextIdentity.publicKey, landing.workspaceId)');
    expect(landing).toContain('router.push(welcomeRoomHref(landing) as Href)');
    // The deck keeps bootstrapping underneath; the claim is never a replace.
    expect(landing).not.toContain('router.replace(welcomeRoomHref');
  });
});
