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

  it('shows the Room loader whenever the Room deck itself is loading', () => {
    expect(source).toContain('<RoomDeckLoadingView');
    expect(source).not.toContain('consumeFirstRoomDeckAfterBoot');
    expect(source).not.toContain('suppressFirstDeckPaint');
    expect(source).not.toContain('suppressPaint=');
  });

  it('sends a person with zero Workspaces to the create-or-join choice, only on a live read', () => {
    const emptyState = source.slice(
      source.indexOf('if (noWorkspace) {'),
      source.indexOf('if (!chatList && !error)'),
    );
    // Never a dead end: the deck shows its loader while the choice replaces it.
    expect(emptyState).toContain('<RoomDeckLoadingView');
    expect(emptyState).not.toContain('No Rooms yet');
    // A cached empty list neither routes anyone nor holds the loader: only the
    // server read can, so an unreachable server reaches the error/retry path.
    expect(source).not.toContain('if (workspaceList?.workspaces.length === 0)');
    expect(source).toContain('setWorkspacesConfirmed(true)');
    expect(source).toContain(
      'const noWorkspace = workspacesConfirmed && workspaceList?.workspaces.length === 0;',
    );
    expect(source).toContain("if (noWorkspace) router.replace('/beeline/community');");
  });

  it('lets an invite opened before sign-in win over every other landing', () => {
    const boot = source.slice(
      source.indexOf('const nextIdentity = await loadBuzzIdentity();'),
      source.indexOf('const nextRelayUrl = await getEffectiveRelayUrl();'),
    );
    expect(boot).toContain('const pendingInvite = await loadPendingInvite();');
    expect(boot).toContain("pathname: '/join/[token]', params: { token: pendingInvite }");
  });

  it('puts start-Room and connect-Agent buttons directly on the empty Room deck', () => {
    const emptyDeck = source.slice(
      source.indexOf('function EmptyRoomActions'),
      source.indexOf('function firstParam'),
    );
    expect(emptyDeck).toContain('testID="empty-add-room"');
    expect(emptyDeck).toContain('onPress={onAddRoom}');
    expect(emptyDeck).toContain('testID="empty-connect-agent"');
    expect(emptyDeck).toContain('onPress={onConnectAgent}');
    expect(emptyDeck).toContain('Start a Room</Text>');
    expect(emptyDeck).toContain('Connect an agent</Text>');
    expect(emptyDeck).not.toContain('label="ADD ROOM"');
    expect(emptyDeck).not.toContain('label="CONNECT AGENT"');
    expect(emptyDeck).not.toContain('<MonoButton');
  });

  it('wires the buttons to the existing Room dialog and shared agent-connect sheet', () => {
    expect(source).toContain('onAddRoom={() => setShowCreateRoom(true)}');
    expect(source).toContain('onConnectAgent={() => void connectAgent()}');
    expect(source).toMatch(/\(\s*await transport\.ensureClient\(\)\s*\)\.createAgentPairingCode\(/);
    expect(source).toContain('<MemberPickerSheet');
    expect(source).toContain('agentConnectOnly');
    expect(source).toContain('testID="empty-agent-connect-sheet"');
    expect(source).toContain('onCopyPairCommand={(command) => void copyPairCommand(command)}');
  });

  it('opens the existing Room dialog for a fresh desktop navigation request', () => {
    expect(source).toContain('requestedNewRoom === handledNewRoomRequest.current');
    expect(source).toContain('handledNewRoomRequest.current = requestedNewRoom');
    expect(source).toContain('setShowCreateRoom(true)');
    expect(source).toContain('!canManageWorkspace');
  });

  it('opens the shared direct-message picker for a fresh desktop DM request', () => {
    expect(source).toContain('handledNewDirectMessageRequest.current = requestedNewDirectMessage');
    expect(source).toContain('setMemberPickerVisible(true)');
    expect(source).toContain('!viewerIsAgent');
  });

  it('refetches an acknowledged Room write without leaving the refreshed deck', () => {
    const createPath = source.slice(
      source.indexOf('const createRoom = useCallback'),
      source.indexOf('const compose = useCallback'),
    );
    expect(createPath).toContain('chatScheduler.current?.force()');
    expect(createPath).not.toContain('openRoom(roomId)');
  });

  it('does not auto-open a Room before the stored Workspace is read', () => {
    const bootstrap = source.slice(
      source.indexOf('const nextIdentity = await loadBuzzIdentity()'),
      source.indexOf('const storedWorkspaceId = await loadActiveCommunityId'),
    );
    expect(bootstrap).not.toContain('claimFirstLaunchLanding');
    expect(bootstrap).not.toContain('welcomeRoomHref');
    expect(bootstrap).not.toContain('/beeline/chat/');
  });

  it('reinstalls Room-deck watches from chats watchFilters and never seeds a Workspace #h', () => {
    expect(source).toContain('installChatWatch');
    expect(source).toContain('nextWatchKey !== chatWatchKey');
    expect(source).toContain('cachedChats?.watchFilters ?? []');
    expect(source).not.toContain("'#h': [selectedId]");
    expect(source).toContain('if (filters.length === 0) return');
  });
});
